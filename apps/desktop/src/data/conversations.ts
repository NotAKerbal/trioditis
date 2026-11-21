import { cardTitle, contactKey, type Network, type Person } from '@trioditis/core'
import { useMemo, useSyncExternalStore } from 'react'

// A person's direct chats on every network, shown as one conversation. The server can't put
// them together: who a direct chat is with (`dmGhostId`) and which contacts a People card
// links are both sealed. So this device does, from the chats it has loaded and the person's
// cards. See client-api.md, Conversations.

/** The most direct chats one conversation holds: one pane keeps a page of messages for each. */
export const MAX_MERGED = 6

/** The People card a conversation is with. */
export interface PersonRef {
  personKey: string
  name: string
  /** The card's own picture, a data URL, when it has one. */
  photo: string | undefined
}

/** What merging needs to know about a chat. */
export interface Mergeable {
  id: string
  network: Network
  row: { kind: string }
  dmGhostId: string | undefined
}

/** Which card each linked contact is on, by `contactKey`, with what a conversation shows of it. */
export function cardIndex(people: readonly Person[] | undefined): Map<string, PersonRef> {
  const out = new Map<string, PersonRef>()
  for (const { personKey, card } of people ?? []) {
    const ref: PersonRef = { personKey, name: cardTitle(card), photo: card.photo }
    for (const link of card.links ?? []) out.set(contactKey(link), ref)
  }
  return out
}

/** The card a direct chat is with, if its other person is linked to one. */
export function cardOfChat(chat: Mergeable, cards: ReadonlyMap<string, PersonRef>): PersonRef | undefined {
  if (chat.row.kind !== 'dm' || !chat.dmGhostId) return undefined
  return cards.get(contactKey({ network: chat.network, ghostId: chat.dmGhostId }))
}

/**
 * The list with each person's direct chats put together: in the place of the first of them,
 * which keeps the list's own order (pins first, then the newest), with the rest after it in
 * list order. Everything else stays as it is. A person with more than MAX_MERGED direct chats
 * here has the first MAX_MERGED together, and the rest on their own.
 */
export function mergeDms<C extends Mergeable>(
  chats: readonly C[],
  cards: ReadonlyMap<string, PersonRef>,
): { first: C; members: C[]; person: PersonRef | undefined }[] {
  const byPerson = new Map<string, C[]>()
  for (const chat of chats) {
    const person = cardOfChat(chat, cards)
    if (!person) continue
    const members = byPerson.get(person.personKey) ?? []
    if (members.length < MAX_MERGED) members.push(chat)
    byPerson.set(person.personKey, members)
  }
  const out: { first: C; members: C[]; person: PersonRef | undefined }[] = []
  for (const chat of chats) {
    const person = cardOfChat(chat, cards)
    const members = person ? byPerson.get(person.personKey) : undefined
    if (!person || !members?.includes(chat)) out.push({ first: chat, members: [chat], person })
    else if (members[0] === chat) out.push({ first: chat, members, person })
  }
  return out
}

// Which conversation each chat the sidebar shows is in, so the open chat's pane shows all of
// its person's chats and the shell acts on all of them. Kept by the sidebar as its lists
// change; a chat it hasn't loaded is a conversation of its own.

type Listener = () => void
let index = new Map<string, readonly string[]>()
const listeners = new Set<Listener>()

/** Records which chats are together, by every chat's ID. Only a change tells the listeners. */
export function setConversations(groups: readonly (readonly string[])[]) {
  const next = new Map<string, readonly string[]>()
  for (const ids of groups) if (ids.length > 1) for (const id of ids) next.set(id, ids)
  const same = next.size === index.size && [...next].every(([id, ids]) => index.get(id)?.join() === ids.join())
  if (same) return
  index = next
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The IDs of the chats `chatId` is shown together with, itself included, newest first. */
export function useConversationIds(chatId: string | undefined): readonly string[] {
  const ids = useSyncExternalStore(subscribe, () => (chatId ? index.get(chatId) : undefined))
  return useMemo(() => ids ?? (chatId ? [chatId] : []), [ids, chatId])
}

// The direct chat the person has with each contact, among the chats the sidebar has loaded, by
// `contactKey`: a profile opens it rather than starting another.

let dmChats = new Map<string, string>()

/** Records the loaded direct chats by who they're with. Only a change tells the listeners. */
export function setDmChats(chats: readonly Mergeable[]) {
  const next = new Map<string, string>()
  for (const c of chats) {
    if (c.row.kind === 'dm' && c.dmGhostId) {
      const key = contactKey({ network: c.network, ghostId: c.dmGhostId })
      if (!next.has(key)) next.set(key, c.id)
    }
  }
  if (next.size === dmChats.size && [...next].every(([k, id]) => dmChats.get(k) === id)) return
  dmChats = next
  for (const listener of listeners) listener()
}

/** The loaded direct chat with each contact, by `contactKey`. */
export function useDmChats(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => dmChats)
}

/**
 * Which chat each of a conversation's page slots holds, kept from `prev` so a chat keeps its
 * slot (and the pages it has loaded) while the conversation's order changes with each new
 * message. A chat no longer in it frees its slot; a new one takes the first free slot.
 */
export function stableSlots(prev: readonly (string | undefined)[], ids: readonly string[]): (string | undefined)[] {
  const wanted = new Set(ids.slice(0, MAX_MERGED))
  const slots = Array.from({ length: MAX_MERGED }, (_, i) => (prev[i] && wanted.has(prev[i]) ? prev[i] : undefined))
  for (const id of wanted) {
    if (slots.includes(id)) continue
    const free = slots.indexOf(undefined)
    if (free >= 0) slots[free] = id
  }
  return slots
}

// A chat the person chose to send on, from a profile's Message or Open: the conversation's pane
// sends on it, whether it was open already or opens now.

let sendRequest: string | null = null

/** Asks the open conversation's pane to send on this chat. */
export function requestSendOn(chatId: string) {
  sendRequest = chatId
  for (const listener of listeners) listener()
}

/** Takes the chat asked to send on, if it's one of these. */
export function takeSendRequest(chatIds: readonly string[]): string | null {
  if (!sendRequest || !chatIds.includes(sendRequest)) return null
  const id = sendRequest
  sendRequest = null
  return id
}

/** The chat asked to send on, as it changes. */
export function useSendRequest(): string | null {
  return useSyncExternalStore(subscribe, () => sendRequest)
}

/** Labels made unique by numbering any that are still the same, so no two choices look alike. */
export function uniqueLabels(labels: readonly string[]): string[] {
  return labels.map((label, i) => {
    const same = labels.filter((l) => l === label).length
    return same > 1 ? `${label} (${labels.slice(0, i + 1).filter((l) => l === label).length})` : label
  })
}

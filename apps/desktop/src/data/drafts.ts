import { useSyncExternalStore } from 'react'

// Drafts live in memory, per chat, and are kept across a reload only sealed to the person's own
// key (saved-drafts.ts): plaintext never touches the disk. They're kept here, not in a chat
// pane, so a send or schedule that finishes after the person left the chat and came back
// changes the draft they're looking at, never a copy of it.
//
// Sending and scheduling both take the text out of the draft when they start, so it can't go
// out twice, and what's typed meanwhile is a new draft of its own. Only if one doesn't go does
// its text come back, ahead of whatever is in the composer by then.
//
// Each draft has an identity from when it gets its first text until it's sent or emptied. A
// send's client message ID is worked out from it and the text (saved-drafts.ts), so the same
// draft sent from two tabs, or again after a reload, is one send to the server.

export interface Draft<Reply> {
  text: string
  /** The message being replied to, if any. */
  reply: Reply | null
  /** Counts every change, so the composer's view is always the latest. */
  rev: number
  /** This draft's identity while it has something in it; '' when empty. */
  id: string
  /** Emptied by this send (its client message ID), until something is typed again. */
  sent: string | null
}

const store = new Map<string, Draft<unknown>>()
const listeners = new Set<() => void>()
const EMPTY: Draft<never> = { text: '', reply: null, rev: 0, id: '', sent: null }

const filled = (d: { text: string; reply: unknown }) => !!d.text.trim() || d.reply !== null
const newDraftId = () => crypto.randomUUID().replaceAll('-', '')

/** Sends and schedules under way, whose text is out of the draft until they settle. */
let inFlight = 0

/**
 * Runs the send or schedule of a taken draft, putting it back included. Until it settles, the
 * text is in neither the draft nor the server, so `hasDrafts` counts it.
 */
export async function whileSending<T>(work: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await work()
  } finally {
    inFlight--
  }
}

/** Whether a reload would lose text: a draft, a reply in progress, or a send not yet settled. */
export function hasDrafts() {
  if (inFlight > 0) return true
  for (const draft of store.values()) if (filled(draft)) return true
  return false
}

/** Whether a send or schedule is on its way, its text out of the draft and not yet stored. */
export const sendsInFlight = () => inFlight > 0

/** Every chat's draft that has something in it. */
export function allDrafts<Reply>(): [string, Draft<Reply>][] {
  return ([...store] as [string, Draft<Reply>][]).filter(([, d]) => filled(d))
}

export function getDraft<Reply>(chatId: string): Draft<Reply> {
  return (store.get(chatId) as Draft<Reply> | undefined) ?? EMPTY
}

/**
 * Changes a draft. One that gets something in it after being empty is a new draft, with a new
 * identity unless `id` names the one it's coming back as; one emptied has none.
 */
function change<Reply>(
  chatId: string,
  next: Partial<Pick<Draft<Reply>, 'text' | 'reply'>>,
  { id, sent = null }: { id?: string; sent?: string | null } = {},
) {
  const draft = getDraft<Reply>(chatId)
  const merged = { ...draft, ...next }
  const has = filled(merged)
  const identity = !has ? '' : filled(draft) && draft.id ? draft.id : (id ?? newDraftId())
  // Kept even when empty, so the revision only ever goes up.
  store.set(chatId, { ...merged, rev: draft.rev + 1, id: identity, sent: has ? null : sent })
  for (const listener of listeners) listener()
}

export const setDraftText = (chatId: string, text: string) => change(chatId, { text })
export const setDraftReply = <Reply>(chatId: string, reply: Reply | null) => change(chatId, { reply })

/**
 * Takes the draft to send or schedule, leaving the composer empty. Null when there's nothing to
 * take. Put it back with `restoreDraft` if it doesn't go.
 */
export function takeDraft<Reply>(chatId: string): { text: string; reply: Reply | null; id: string } | null {
  const { text, reply, id } = getDraft<Reply>(chatId)
  if (!text.trim()) return null
  change<Reply>(chatId, { text: '', reply: null })
  return { text: text.trim(), reply, id }
}

/**
 * Puts back a send or schedule that didn't go: its text ahead of anything typed since, its reply
 * if none is set. Into an empty composer it comes back as the same draft (`id`), so sending it
 * again is the same send.
 */
export function restoreDraft<Reply>(chatId: string, text: string, reply: Reply | null, id?: string) {
  const now = getDraft<Reply>(chatId)
  change(chatId, { text: now.text ? `${text}\n${now.text}` : text, reply: now.reply ?? reply }, { id })
}

/** Brings back a draft saved before a reload, as the same draft, into a chat with none. */
export function adoptDraft<Reply>(chatId: string, text: string, reply: Reply | null, id: string) {
  if (filled(getDraft(chatId))) return
  change<Reply>(chatId, { text, reply }, { id })
}

/** Notes that the draft taken as `id` went, as `clientMessageId`, if nothing's been typed since. */
export function markDraftSent(chatId: string, clientMessageId: string) {
  const now = getDraft(chatId)
  if (filled(now) || now.sent === clientMessageId) return
  change(chatId, {}, { sent: clientMessageId })
}

/** Empties a draft another tab has sent, unless `stillSame` says it has changed since. */
export function clearSentDraft<Reply>(chatId: string, stillSame: (draft: Draft<Reply>) => boolean) {
  const now = getDraft<Reply>(chatId)
  if (!filled(now) || !stillSame(now)) return false
  change<Reply>(chatId, { text: '', reply: null })
  return true
}

/**
 * Adds a cancelled scheduled message's text below the draft, and its reply if the draft has
 * none: a reply already set is the newer choice. Says whether there was a draft already.
 */
export function appendToDraft<Reply>(chatId: string, text: string, reply: Reply | null = null): boolean {
  const now = getDraft<Reply>(chatId)
  change<Reply>(chatId, { text: now.text.trim() ? `${now.text}\n${text}` : text, reply: now.reply ?? reply })
  return !!now.text.trim()
}

/** Calls `listener` after every change to any draft. */
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const subscribe = subscribeDrafts

/** A chat's draft, kept up to date with every change, from wherever it came. */
export function useDraft<Reply>(chatId: string): Draft<Reply> {
  return useSyncExternalStore(subscribe, () => getDraft<Reply>(chatId))
}

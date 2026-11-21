import { digest, sealJson, type Envelope, type KeyPair } from '@trioditis/crypto'
import { tryOpen } from '~/lib/sealed.ts'

// Unsent text, kept across a reload in this browser's storage, each piece sealed to the person's
// own identity key (kind `draft`, object ID the chat's ID; sealing.md). What's stored is
// ciphertext, the chat IDs that have something kept, random identities and client message IDs:
// nothing readable. Text, and the message it replies to, open only with the key this device
// unlocks; anything saved by another account, or for another key, doesn't open, and is left out.
//
// Each chat has entries of its own, so tabs saving different chats never touch each other's:
//   trioditis.draft.<user>.<chat>              its draft, with who wrote it (`w`)
//   trioditis.draftSending.<user>.<chat>.<id>  a send or schedule under way, until it settles
//   trioditis.draftHeld.<user>.<chat>          messages waiting for the composer to be free
//   trioditis.draftSent.<user>.<chat>          the last draft sent from it, by client message ID

export interface SavedDraft<Reply> {
  text: string
  reply: Reply | null
  /** The draft's identity (drafts.ts). */
  id: string
}

export interface Owner {
  userId: string
  keyPair: KeyPair
}

/** The storage this runs on: localStorage in the app; anything shaped like it in a test. */
export interface DraftStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Kind = 'draft' | 'draftSending' | 'draftHeld' | 'draftSent'
const prefix = (kind: Kind, userId: string) => `trioditis.${kind}.${userId}.`
export const savedDraftKey = (userId: string, chatId: string) => `${prefix('draft', userId)}${chatId}`
const sendingKey = (userId: string, chatId: string, sendId: string) =>
  `${prefix('draftSending', userId)}${chatId}.${sendId}`
const heldKey = (userId: string, chatId: string) => `${prefix('draftHeld', userId)}${chatId}`
const sentKey = (userId: string, chatId: string) => `${prefix('draftSent', userId)}${chatId}`

/** What a storage key keeps for this person: its kind and chat (and send), or null. */
export function keyOf(userId: string, key: string | null) {
  for (const kind of ['draftSending', 'draftHeld', 'draftSent', 'draft'] as const) {
    const p = prefix(kind, userId)
    if (!key?.startsWith(p)) continue
    const rest = key.slice(p.length)
    if (kind !== 'draftSending') return rest ? { kind, chatId: rest, sendId: '' } : null
    const dot = rest.lastIndexOf('.')
    return dot > 0 ? { kind, chatId: rest.slice(0, dot), sendId: rest.slice(dot + 1) } : null
  }
  return null
}

/**
 * The client message ID for sending this draft: a hash of its identity, the message it replies
 * to and its text. The same draft sent twice, from two tabs or across a reload, is one send to
 * the server; any change makes it a different one. The identity is random and never leaves this
 * browser, so the ID says nothing about the text.
 */
export function draftSendId(id: string, text: string, replyEventId: string | undefined): string {
  return `d_${digest(`trioditis/draft-send/v1/${id}\n${replyEventId ?? ''}\n${text.trim()}`)}`
}

function json(value: string | null): Record<string, unknown> | null {
  try {
    const v = JSON.parse(value ?? 'null') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const seal = (value: unknown, owner: Owner, chatId: string) =>
  sealJson(value, [{ publicKey: owner.keyPair.publicKey }], {
    kind: 'draft',
    ownerUserId: owner.userId,
    objectId: chatId,
  })
const open = <T>(sealed: unknown, owner: Owner, chatId: string) =>
  sealed && typeof sealed === 'object'
    ? tryOpen<T>(sealed as Envelope, owner.keyPair, 'draft', owner.userId, chatId)
    : null

/** Which write a stored draft is, so a tab removes only one it wrote or read itself. */
export const draftWriter = (storage: DraftStorage, userId: string, chatId: string): string | null => {
  const w = json(storage.getItem(savedDraftKey(userId, chatId)))?.w
  return typeof w === 'string' ? w : null
}

/** Saves a chat's draft; returns this write's mark (`w`), to know it again. Throws if storage refuses. */
export function writeDraft<Reply>(storage: DraftStorage, owner: Owner, chatId: string, draft: SavedDraft<Reply>) {
  const w = crypto.randomUUID()
  const sealed = seal({ text: draft.text, reply: draft.reply }, owner, chatId)
  storage.setItem(savedDraftKey(owner.userId, chatId), JSON.stringify({ v: 1, id: draft.id, w, sealed }))
  return w
}

/**
 * Removes a chat's saved draft, but only the one `w` names: what this tab wrote or brought back.
 * Another tab's newer draft for the chat stays. Says whether it went.
 */
export function removeDraftIfOurs(storage: DraftStorage, userId: string, chatId: string, w: string | undefined) {
  if (!w || draftWriter(storage, userId, chatId) !== w) return false
  storage.removeItem(savedDraftKey(userId, chatId))
  return true
}

export function writeSending<Reply>(
  storage: DraftStorage,
  owner: Owner,
  chatId: string,
  sendId: string,
  draft: SavedDraft<Reply>,
) {
  const sealed = seal({ text: draft.text, reply: draft.reply }, owner, chatId)
  storage.setItem(sendingKey(owner.userId, chatId, sendId), JSON.stringify({ v: 1, id: draft.id, sealed }))
}

export const removeSending = (storage: DraftStorage, userId: string, chatId: string, sendId: string) =>
  storage.removeItem(sendingKey(userId, chatId, sendId))

/** Saves a chat's held messages (none removes them). */
export function writeHeld<Reply>(
  storage: DraftStorage,
  owner: Owner,
  chatId: string,
  list: { text: string; reply: Reply | null; id?: string }[],
) {
  const key = heldKey(owner.userId, chatId)
  if (!list.length) return storage.removeItem(key)
  storage.setItem(key, JSON.stringify({ v: 1, sealed: seal(list, owner, chatId) }))
}

/** Notes that `sendId` took the chat's draft, for other tabs and the next load. */
export const writeSent = (storage: DraftStorage, userId: string, chatId: string, sendId: string) =>
  storage.setItem(sentKey(userId, chatId), JSON.stringify({ v: 1, sent: sendId }))

/** The send a stored sent note names, if `value` is one. */
export function parseSent(value: string | null): string | null {
  const entry = json(value)
  return entry?.v === 1 && typeof entry.sent === 'string' ? entry.sent : null
}

export interface Loaded<Reply> {
  drafts: Map<string, SavedDraft<Reply> & { w: string }>
  sending: { chatId: string; sendId: string; draft: SavedDraft<Reply> }[]
  held: Map<string, { text: string; reply: Reply | null; id?: string }[]>
  sent: Map<string, string>
}

/** Everything saved for this person that opens with their key. */
export function loadAll<Reply>(storage: DraftStorage, owner: Owner): Loaded<Reply> {
  const out: Loaded<Reply> = { drafts: new Map(), sending: [], held: new Map(), sent: new Map() }
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) keys.push(storage.key(i) ?? '')
  for (const key of keys) {
    const at = keyOf(owner.userId, key)
    if (!at) continue
    const value = storage.getItem(key)
    if (at.kind === 'draftSent') {
      const sent = parseSent(value)
      if (sent) out.sent.set(at.chatId, sent)
      continue
    }
    const entry = json(value)
    if (entry?.v !== 1) continue
    if (at.kind === 'draftHeld') {
      const list = open<{ text: string; reply: Reply | null; id?: string }[]>(entry.sealed, owner, at.chatId)
      if (Array.isArray(list))
        out.held.set(
          at.chatId,
          list.filter((d) => typeof d?.text === 'string'),
        )
      continue
    }
    const opened = open<{ text: unknown; reply?: Reply }>(entry.sealed, owner, at.chatId)
    if (!opened || typeof opened.text !== 'string' || typeof entry.id !== 'string') continue
    const draft = { text: opened.text, reply: opened.reply ?? null, id: entry.id }
    if (at.kind === 'draftSending') out.sending.push({ chatId: at.chatId, sendId: at.sendId, draft })
    else if (typeof entry.w === 'string') out.drafts.set(at.chatId, { ...draft, w: entry.w })
  }
  return out
}

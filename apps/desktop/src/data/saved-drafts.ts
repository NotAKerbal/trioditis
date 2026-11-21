import { digest, sealJson, type Envelope, type KeyPair } from '@trioditis/crypto'
import { tryOpen } from '~/lib/sealed.ts'

// Unsent text, kept across a reload in this browser's storage, each piece sealed to the person's
// own identity key (kind `draft`, object ID the chat's ID; sealing.md). What's stored is
// ciphertext, the chat IDs that have something kept, random identities and client message IDs:
// nothing readable. Text, and the message it replies to, open only with the key this device
// unlocks; anything saved by another account, or for another key, doesn't open, and is left out.
//
// Each chat has entries of its own, so tabs saving different chats never touch each other's:
//   trioditis.draft.<user>.<chat>                   its draft, with which write it is (`w`)
//   trioditis.draftSending.<user>.<chat>.<sendId>   a send or schedule under way, until it settles
//   trioditis.draftSent.<user>.<chat>               the last draft sent from it, by client message ID
//
// Two rules keep them right across tabs and crashes:
//
// I1. Every change to a chat's entries runs inside the Web Locks lock
//     `trioditis.drafts.<user>.<chat>` (withChatLock), reading storage again inside it, so one
//     tab's read-then-write never interleaves with another's. Without Web Locks, as before.
// I2. Write before delete. A draft taken to send is saved as a send under way before the
//     composer's saved draft is cleared or replaced, and a send under way that comes back to
//     the composer is deleted only once that draft is saved. A write that fails deletes and
//     replaces nothing after it, and the chat stays unsaved, so leaving the page asks first. A
//     tab deletes only entries it wrote or read itself: never one another tab saved that it
//     hasn't seen.
//
// A cancelled scheduled message isn't kept here: the server keeps its sealed copy until the
// client has saved its text as the draft and forgets it (scheduled.forget, client-api.md).

export interface SavedDraft<Reply> {
  text: string
  reply: Reply | null
  /** The draft's identity (drafts.ts). */
  id: string
  /** Cancelled scheduled messages restored into it (drafts.ts). */
  origins?: string[]
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

type Kind = 'draft' | 'draftSending' | 'draftSent'
const prefix = (kind: Kind, userId: string) => `trioditis.${kind}.${userId}.`
export const savedDraftKey = (userId: string, chatId: string) => `${prefix('draft', userId)}${chatId}`
const sendingKey = (userId: string, chatId: string, sendId: string) =>
  `${prefix('draftSending', userId)}${chatId}.${sendId}`
const sentKey = (userId: string, chatId: string) => `${prefix('draftSent', userId)}${chatId}`

/** What a storage key keeps for this person: its kind, chat and (for a send) ID; or null. */
export function keyOf(userId: string, key: string | null): { kind: Kind; chatId: string; sub: string } | null {
  for (const kind of ['draftSending', 'draftSent', 'draft'] as const) {
    const p = prefix(kind, userId)
    if (!key?.startsWith(p)) continue
    const rest = key.slice(p.length)
    if (kind === 'draft' || kind === 'draftSent') return rest ? { kind, chatId: rest, sub: '' } : null
    const dot = rest.lastIndexOf('.')
    return dot > 0 && dot < rest.length - 1 ? { kind, chatId: rest.slice(0, dot), sub: rest.slice(dot + 1) } : null
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

/** Runs `work` holding the chat's drafts lock (I1), or straight away where there are no Web Locks. */
export function withChatLock<T>(userId: string, chatId: string, work: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return Promise.resolve().then(work)
  return locks.request(`trioditis.drafts.${userId}.${chatId}`, work) as Promise<T>
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

const sealedCopy = <Reply>(owner: Owner, chatId: string, copy: SavedDraft<Reply>, extra: object = {}) =>
  JSON.stringify({
    v: 1,
    id: copy.id,
    sealed: seal({ text: copy.text, reply: copy.reply, origins: copy.origins ?? [] }, owner, chatId),
    ...extra,
  })

function openCopy<Reply>(
  value: string | null,
  owner: Owner,
  chatId: string,
): (SavedDraft<Reply> & { w?: string }) | null {
  const entry = json(value)
  if (entry?.v !== 1 || typeof entry.id !== 'string' || !entry.id || !entry.sealed || typeof entry.sealed !== 'object')
    return null
  const opened = tryOpen<{ text: unknown; reply?: Reply; origins?: unknown }>(
    entry.sealed as Envelope,
    owner.keyPair,
    'draft',
    owner.userId,
    chatId,
  )
  if (!opened || typeof opened.text !== 'string') return null
  return {
    text: opened.text,
    reply: opened.reply ?? null,
    id: entry.id,
    origins: Array.isArray(opened.origins) ? opened.origins.filter((o): o is string => typeof o === 'string') : [],
    ...(typeof entry.w === 'string' ? { w: entry.w } : {}),
  }
}

/** The send a stored sent note names, if `value` is one. */
export function parseSent(value: string | null): string | null {
  const entry = json(value)
  return entry?.v === 1 && typeof entry.sent === 'string' ? entry.sent : null
}

export interface Loaded<Reply> {
  drafts: Map<string, SavedDraft<Reply> & { w: string }>
  sending: { chatId: string; sendId: string; copy: SavedDraft<Reply> }[]
  sent: Map<string, string>
}

/** Everything saved for this person that opens with their key. */
export function loadAll<Reply>(storage: DraftStorage, owner: Owner): Loaded<Reply> {
  const out: Loaded<Reply> = { drafts: new Map(), sending: [], sent: new Map() }
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
    const copy = openCopy<Reply>(value, owner, at.chatId)
    if (!copy) continue
    const { w, ...draft } = copy
    if (at.kind === 'draft' && w) out.drafts.set(at.chatId, { ...draft, w })
    if (at.kind === 'draftSending') out.sending.push({ chatId: at.chatId, sendId: at.sub, copy: draft })
  }
  return out
}

/** What this tab wants stored for a chat, from its memory (drafts.ts). */
export interface ChatWant<Reply> {
  /** The composer's draft; null when empty. */
  draft: SavedDraft<Reply> | null
  /** Whether the draft changed since this tab last saved it. */
  draftChanged: boolean
  sending: Map<string, SavedDraft<Reply>>
  /** Sends that took the chat's draft, to note for other tabs. */
  sent: string[]
}

/** What this tab has stored for a chat or read from it: the only entries it may delete (I2). */
export interface ChatKnown {
  /** The mark of the draft write this tab made or read. */
  w: string | undefined
  sending: Set<string>
}

export const newKnown = (): ChatKnown => ({ w: undefined, sending: new Set() })

/**
 * Brings a chat's stored entries to what `want` says, under I2: everything to write first, and
 * only if all of that was written, the deletions, of entries `known` says this tab wrote or read.
 * Call inside withChatLock (I1). Says whether everything was saved; if not, nothing was deleted.
 */
export function syncChat<Reply>(
  storage: DraftStorage,
  owner: Owner,
  chatId: string,
  want: ChatWant<Reply>,
  known: ChatKnown,
): boolean {
  const { userId } = owner
  try {
    // A send under way first: the draft it was taken from is replaced or cleared only after.
    for (const [sendId, copy] of want.sending)
      if (!known.sending.has(sendId)) {
        storage.setItem(sendingKey(userId, chatId, sendId), sealedCopy(owner, chatId, copy))
        known.sending.add(sendId)
      }
    for (const sent of want.sent) storage.setItem(sentKey(userId, chatId), JSON.stringify({ v: 1, sent }))
    if (want.draft && want.draftChanged) {
      const w = crypto.randomUUID()
      storage.setItem(savedDraftKey(userId, chatId), sealedCopy(owner, chatId, want.draft, { w }))
      known.w = w
    }
  } catch {
    return false
  }
  // Everything is where it's going: now what's moved on can go.
  if (!want.draft && want.draftChanged && known.w) {
    // Only the draft this tab wrote or read; another tab's newer one stays.
    if (json(storage.getItem(savedDraftKey(userId, chatId)))?.w === known.w)
      storage.removeItem(savedDraftKey(userId, chatId))
    known.w = undefined
  }
  for (const sendId of known.sending)
    if (!want.sending.has(sendId)) {
      storage.removeItem(sendingKey(userId, chatId, sendId))
      known.sending.delete(sendId)
    }
  return true
}

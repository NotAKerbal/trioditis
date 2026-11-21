import { digest, sealJson, type Envelope, type KeyPair } from '@trioditis/crypto'
import { tryOpen } from '~/lib/sealed.ts'

// Unsent drafts, kept across a reload in this browser's storage, each sealed to the person's own
// identity key (kind `draft`, object ID the chat's ID; sealing.md). What's stored is ciphertext,
// the chat IDs that have a draft, and each draft's random identity: nothing readable. The text,
// and the message it replies to, open only with the key this device unlocks. A draft saved by
// another account, or for another key, doesn't open, and is left out.
//
// Each chat has its own entry, so tabs saving different chats never touch each other's. When a
// draft is sent its entry becomes a note of the send (`sent`, its client message ID), so other
// tabs holding the same draft empty theirs rather than send it again.

export interface SavedDraft<Reply> {
  text: string
  reply: Reply | null
  /** The draft's identity (drafts.ts). */
  id: string
}

/** A chat's entry: its sealed draft, or the send that took it. */
export type DraftEntry = { v: 1; id: string; sealed: Envelope } | { v: 1; sent: string }

const prefix = (userId: string) => `trioditis.draft.${userId}.`
/** Where one chat's draft is kept: per account, so a sign-in as someone else never sees it. */
export const savedDraftKey = (userId: string, chatId: string) => `${prefix(userId)}${chatId}`

/** The chat a storage key keeps a draft for, if it's one of this person's. */
export function draftChatOf(userId: string, key: string | null): string | null {
  return key?.startsWith(prefix(userId)) ? key.slice(prefix(userId).length) || null : null
}

interface Owner {
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

/** A stored entry, or null if it's missing or isn't one. */
export function parseEntry(value: string | null): DraftEntry | null {
  try {
    const entry = JSON.parse(value ?? 'null') as Record<string, unknown> | null
    if (!entry || entry.v !== 1) return null
    if (typeof entry.sent === 'string') return { v: 1, sent: entry.sent }
    if (typeof entry.id === 'string' && entry.sealed && typeof entry.sealed === 'object')
      return { v: 1, id: entry.id, sealed: entry.sealed as Envelope }
    return null
  } catch {
    return null
  }
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

/** The drafts saved for this person that open with their key, by chat ID. */
export function loadDrafts<Reply>(storage: DraftStorage, owner: Owner): Map<string, SavedDraft<Reply>> {
  const out = new Map<string, SavedDraft<Reply>>()
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) keys.push(storage.key(i) ?? '')
  for (const key of keys) {
    const chatId = draftChatOf(owner.userId, key)
    if (!chatId) continue
    const entry = parseEntry(storage.getItem(key))
    if (!entry || !('sealed' in entry)) continue
    const draft = tryOpen<{ text: unknown; reply?: Reply }>(entry.sealed, owner.keyPair, 'draft', owner.userId, chatId)
    if (draft && typeof draft.text === 'string')
      out.set(chatId, { text: draft.text, reply: draft.reply ?? null, id: entry.id })
  }
  return out
}

/**
 * Saves one chat's draft: sealed if it has something in it; else the send that emptied it, if
 * one did; else nothing, removing what was there. Throws if storage refuses.
 */
export function saveDraft<Reply>(
  storage: DraftStorage,
  owner: Owner,
  chatId: string,
  draft: SavedDraft<Reply> | null,
  sent: string | null = null,
) {
  const key = savedDraftKey(owner.userId, chatId)
  if (draft && (draft.text.trim() || draft.reply)) {
    const sealed = sealJson({ text: draft.text, reply: draft.reply }, [{ publicKey: owner.keyPair.publicKey }], {
      kind: 'draft',
      ownerUserId: owner.userId,
      objectId: chatId,
    })
    storage.setItem(key, JSON.stringify({ v: 1, id: draft.id, sealed } satisfies DraftEntry))
  } else if (sent) storage.setItem(key, JSON.stringify({ v: 1, sent } satisfies DraftEntry))
  else storage.removeItem(key)
}

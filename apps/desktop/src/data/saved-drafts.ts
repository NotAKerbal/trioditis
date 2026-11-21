import { sealJson, type Envelope, type KeyPair } from '@trioditis/crypto'
import { tryOpen } from '~/lib/sealed.ts'

// Unsent drafts, kept across a reload in this browser's storage, each sealed to the person's own
// identity key (kind `draft`, object ID the chat's ID; sealing.md). What's stored is ciphertext
// and the chat IDs that have a draft, nothing readable: the text, and the message it replies
// to, open only with the key this device unlocks. A draft saved by another account, or for
// another key, doesn't open, and is left out.

export interface SavedDraft<Reply> {
  text: string
  reply: Reply | null
}

/** Where they're kept: one entry per account, so a sign-in as someone else never sees them. */
export const savedDraftsKey = (userId: string) => `trioditis.drafts.${userId}`

type Stored = Record<string, Envelope>

interface Owner {
  userId: string
  keyPair: KeyPair
}

/** The storage this runs on: localStorage in the app; anything shaped like it in a test. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function read(storage: DraftStorage, userId: string): Stored {
  try {
    const parsed = JSON.parse(storage.getItem(savedDraftsKey(userId)) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {}
  } catch {
    return {}
  }
}

/** The drafts saved for this person that open with their key, by chat ID. */
export function loadDrafts<Reply>(storage: DraftStorage, owner: Owner): Map<string, SavedDraft<Reply>> {
  const out = new Map<string, SavedDraft<Reply>>()
  for (const [chatId, envelope] of Object.entries(read(storage, owner.userId))) {
    const draft = tryOpen<SavedDraft<Reply>>(envelope, owner.keyPair, 'draft', owner.userId, chatId)
    if (draft && typeof draft.text === 'string') out.set(chatId, { text: draft.text, reply: draft.reply ?? null })
  }
  return out
}

/**
 * Saves the drafts of `changed` chats, as they are now in `drafts` (one missing or empty is
 * removed), and leaves every other chat's saved draft as it is: another tab may have saved it,
 * and only what this tab changed is this tab's to overwrite. Throws if storage refuses.
 */
export function saveDrafts<Reply>(
  storage: DraftStorage,
  owner: Owner,
  changed: Iterable<string>,
  drafts: ReadonlyMap<string, SavedDraft<Reply>>,
) {
  const stored = read(storage, owner.userId)
  for (const chatId of changed) {
    const draft = drafts.get(chatId)
    if (!draft || (!draft.text.trim() && !draft.reply)) {
      delete stored[chatId]
      continue
    }
    stored[chatId] = sealJson({ text: draft.text, reply: draft.reply }, [{ publicKey: owner.keyPair.publicKey }], {
      kind: 'draft',
      ownerUserId: owner.userId,
      objectId: chatId,
    })
  }
  const key = savedDraftsKey(owner.userId)
  if (Object.keys(stored).length) storage.setItem(key, JSON.stringify(stored))
  else storage.removeItem(key)
}

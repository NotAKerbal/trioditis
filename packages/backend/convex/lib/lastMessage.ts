import { compareValues, type Infer } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { storedLastMessage } from '../validators'
import { byteSize } from './bounded'

// Each chat's pointer to its newest message (`chats.last`), so the chat list shows a preview
// without reading a message per row. Newest is by `sortKey`, the order `messages.list` shows,
// so the preview is always the message at the top of the chat, imported history included.
//
// The pointer is always the chat's largest `sortKey`. So a message written or changed only
// needs comparing with it, and the chat's messages are read only when the one it points at
// moves down (an echo with an earlier time) or goes away (a discarded send): then the
// newest is one index read. A chat from before the pointer was kept has none (`undefined`)
// and gets one the same way, the first time a message in it is written or changed, or when
// the backfill reaches it.
//
// Keys are compared as Convex's index compares them (`compareValues`, UTF-8 order), not with
// JavaScript's `<` (UTF-16 order): the two disagree for some event IDs, and the pointer must
// agree with the order `messages.list` reads.

/**
 * The largest envelope the pointer keeps, as stored (its JSON in UTF-8). A text message fits
 * easily; a bigger one is left out, so a page of 50 chats stays small, and the client shows
 * a placeholder for it.
 */
export const MAX_PREVIEW_SEALED_BYTES = 4 * 1024

type StoredLast = Infer<typeof storedLastMessage>

/** What the pointer needs of a message, so a caller that just wrote one needn't read it back. */
export type MessageFields = Pick<
  Doc<'messages'>,
  '_id' | 'sortKey' | 'networkTs' | 'sender' | 'sealed' | 'sealedObjectId' | 'sealedEdit' | 'editEventId' | 'redactedAt'
>

/** The pointer to `message`: its latest content, opened as `messages.list` says to open it. */
export function lastOf(message: MessageFields): StoredLast {
  const redacted = message.redactedAt !== undefined
  const edited = message.sealedEdit !== undefined && message.editEventId !== undefined
  const sealed = redacted ? undefined : edited ? message.sealedEdit : message.sealed
  return {
    messageId: message._id,
    sortKey: message.sortKey,
    at: message.networkTs,
    self: 'self' in message.sender,
    ...('ghostId' in message.sender ? { ghostId: message.sender.ghostId } : {}),
    redacted,
    ...(sealed && byteSize(sealed) <= MAX_PREVIEW_SEALED_BYTES ? { sealed } : {}),
    objectId: edited ? message.editEventId! : message.sealedObjectId,
  }
}

/**
 * Points the chat at its newest message, reading just that one through the index. Returns
 * the message it read, so ingest can count it against its budget.
 */
export async function refreshLast(ctx: MutationCtx, chatId: Id<'chats'>) {
  const newest = await ctx.db
    .query('messages')
    .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
    .order('desc')
    .first()
  await ctx.db.patch(chatId, { last: newest ? lastOf(newest) : null })
  return newest
}

/**
 * Keeps the pointer right after `message` was inserted into `chat` or changed there: it takes
 * a message newer than the one it has (and never an older one that arrived later), and the
 * new content of the one it has. Returns any message it had to read.
 */
export async function noteMessage(ctx: MutationCtx, chat: Doc<'chats'>, message: MessageFields) {
  const last = chat.last
  if (last === undefined) return await refreshLast(ctx, chat._id)
  if (last !== null && last.messageId === message._id) {
    // It moved down, so another message may be newest now.
    if (compareValues(message.sortKey, last.sortKey) < 0) return await refreshLast(ctx, chat._id)
  } else if (last !== null && compareValues(message.sortKey, last.sortKey) <= 0) return null
  await ctx.db.patch(chat._id, { last: lastOf(message) })
  return null
}

/** Keeps the pointer right after a message was deleted from `chat`. */
export async function forgetMessage(ctx: MutationCtx, chat: Doc<'chats'>, messageId: Id<'messages'>) {
  if (chat.last === undefined || chat.last?.messageId === messageId) return await refreshLast(ctx, chat._id)
  return null
}

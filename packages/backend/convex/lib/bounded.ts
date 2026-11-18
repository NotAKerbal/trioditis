import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

// Reading message rows without passing a transaction's 16 MiB read limit. A message row can
// hold a capped original and its latest edit, so even a few dozen of them can be too many.

const encoder = new TextEncoder()

/** About how many bytes a row takes: its JSON in UTF-8. */
export function byteSize(value: unknown) {
  return encoder.encode(JSON.stringify(value) ?? '').length
}

/** The largest a message row can be: two sealed objects at the cap, their keys and IDs. */
export const MAX_MESSAGE_ROW_BYTES = 768 * 1024

/**
 * The newest message in a chat that `wanted` accepts, looking at no more than `maxRows`
 * messages and `maxBytes` of them. It reads a few rows at a time, only as many as can't pass
 * `maxBytes` however large they are. Null if none of those it could read is wanted.
 */
export async function newestMessageWhere(
  ctx: QueryCtx,
  chatId: Id<'chats'>,
  wanted: (message: Doc<'messages'>) => boolean,
  { maxRows, maxBytes }: { maxRows: number; maxBytes: number },
) {
  let before: string | undefined
  let seen = 0
  let bytes = 0
  while (seen < maxRows) {
    const room = Math.min(Math.floor((maxBytes - bytes) / MAX_MESSAGE_ROW_BYTES), maxRows - seen)
    if (room < 1) return null
    const batch = await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) =>
        before === undefined ? q.eq('chatId', chatId) : q.eq('chatId', chatId).lt('sortKey', before),
      )
      .order('desc')
      .take(room)
    for (const message of batch) {
      if (wanted(message)) return message
      bytes += byteSize(message)
    }
    seen += batch.length
    if (batch.length < room) return null
    before = batch.at(-1)!.sortKey
  }
  return null
}

import type { Arrival, ArrivalFeed } from '@trioditis/core'
import type { Chat } from '~/data/chats.ts'

// Which arrivals get a notification, and what it says, with no browser in them so they can be
// tested. The hook that shows them is features/shell/notifications.ts.

/**
 * How far behind the cursor an arrival still counts, for as long after the cursor moved. A
 * message's `arrivedAt` is when the mutation storing it started, not when it committed, so one
 * that took longer can show up just after a newer one, with an earlier time. Mutations run for
 * a second at most.
 */
export const LATE_MS = 10_000

/**
 * Where notifications are up to: when the newest message arrived as of the previous answer
 * (`ArrivalFeed.latest`, 0 if none had); when, on this device's clock, that last moved; and
 * the arrivals already seen that are recent enough to come again, by when they arrived.
 */
export interface Cursor {
  since: number
  movedAt: number
  seen: Map<string, number>
}

const key = (a: Arrival) => `${a.chat._id}:${a.message.messageId}`

/**
 * The arrivals in `feed` that are new since `cursor`, newest first, each once, as of `now`
 * (`Date.now()`). The first answer (no cursor yet) only sets it, so opening the app doesn't
 * announce what was already there; and an old message that comes into view later (its chat
 * brought back from the archive) arrived before it, and late ones count only just after the
 * cursor moved.
 */
export function newArrivals(
  cursor: Cursor | undefined,
  feed: ArrivalFeed,
  now: number,
): { cursor: Cursor; fresh: Arrival[] } {
  const since = Math.max(cursor?.since ?? 0, feed.latest ?? 0)
  const floor = cursor && now - cursor.movedAt <= LATE_MS ? cursor.since - LATE_MS : (cursor?.since ?? 0)
  const fresh = cursor ? feed.arrivals.filter((a) => a.arrivedAt > floor && !cursor.seen.has(key(a))) : []
  const seen = new Map(cursor?.seen)
  for (const a of feed.arrivals) seen.set(key(a), a.arrivedAt)
  // Older than this, an arrival can't count again however it shows up.
  for (const [k, at] of seen) if (at <= since - LATE_MS) seen.delete(k)
  // The first answer doesn't say when `since` moved, maybe days ago: late arrivals count only
  // once it moves while the app watches.
  const movedAt = !cursor ? -Infinity : since > cursor.since ? now : cursor.movedAt
  return { cursor: { since, movedAt, seen }, fresh }
}

/**
 * Who sent it and what they said, never the network. The chat's name is the sender in a
 * one-to-one chat; a group shows its own name, since the app doesn't know its members' names
 * yet. A chat whose name isn't known yet would be named after its network, so it has none.
 */
export function notificationText(chat: Chat, text: string | null): { title: string; body: string } {
  return { title: chat.named ? chat.name : 'New message', body: text ?? 'New message' }
}

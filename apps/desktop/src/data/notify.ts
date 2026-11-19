import { NETWORK_INFO, type Arrival, type ArrivalFeed } from '@trioditis/core'
import type { Chat } from '~/data/chats.ts'

// Which arrivals get a notification, and what it says, with no browser in them so they can be
// tested. The hook that shows them is features/shell/notifications.ts.

/** What a notification shows. The system can keep notifications in its history, on disk. */
export type NotificationContent = 'network' | 'name' | 'message'

/**
 * How far behind the cursor an arrival still counts. A message's `arrivedAt` is when the
 * mutation storing it started, not when it committed, so one that took longer can show up
 * after a newer one with an earlier time. Mutations run for a second at most.
 */
export const LATE_MS = 10_000

/**
 * Where notifications are up to: when the newest message arrived as of the previous answer
 * (`ArrivalFeed.latest`, 0 if none had), and the arrivals already seen that are recent enough
 * to come again, by when they arrived.
 */
export interface Cursor {
  since: number
  seen: Map<string, number>
}

const key = (a: Arrival) => `${a.chat._id}:${a.message.messageId}`

/**
 * The arrivals in `feed` that are new since `cursor`, newest first, each once. The first
 * answer (no cursor yet) only sets it, so opening the app doesn't announce what was already
 * there; and an old message that comes into view later (its chat brought back from the
 * archive) arrived well before it.
 */
export function newArrivals(cursor: Cursor | undefined, feed: ArrivalFeed): { cursor: Cursor; fresh: Arrival[] } {
  const since = Math.max(cursor?.since ?? 0, feed.latest ?? 0)
  const fresh = cursor
    ? feed.arrivals.filter((a) => a.arrivedAt > cursor.since - LATE_MS && !cursor.seen.has(key(a)))
    : []
  const seen = new Map(cursor?.seen)
  for (const a of feed.arrivals) seen.set(key(a), a.arrivedAt)
  // Older than this, an arrival can't count again however it shows up.
  for (const [k, at] of seen) if (at <= since - LATE_MS) seen.delete(k)
  return { cursor: { since, seen }, fresh }
}

export function notificationText(
  chat: Chat,
  text: string | null,
  content: NotificationContent,
): { title: string; body: string } {
  if (content === 'message') return { title: chat.name, body: text ?? 'New message' }
  if (content === 'name') return { title: chat.name, body: 'New message' }
  return { title: 'New message', body: `On ${NETWORK_INFO[chat.network]?.name ?? chat.network}` }
}

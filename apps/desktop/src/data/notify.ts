import { NETWORK_INFO, type Arrival, type ArrivalFeed } from '@trioditis/core'
import type { Chat } from '~/data/chats.ts'

// Which arrivals get a notification, and what it says, with no browser in them so they can be
// tested. The hook that shows them is features/shell/notifications.ts.

/** What a notification shows. The system can keep notifications in its history, on disk. */
export type NotificationContent = 'network' | 'name' | 'message'

/**
 * When the newest message arrived as of the previous answer (`ArrivalFeed.latest`), or 0 if
 * none had. Undefined before the first answer.
 */
export type Since = number | undefined

/**
 * The arrivals in `feed` that came after `since`, newest first. The first answer only sets
 * the cursor, so opening the app doesn't announce what was already there; and an old message
 * that comes into view later (its chat brought back from the archive) arrived before it.
 */
export function newArrivals(since: Since, feed: ArrivalFeed): { since: number; fresh: Arrival[] } {
  const latest = Math.max(since ?? 0, feed.latest ?? 0)
  if (since === undefined) return { since: latest, fresh: [] }
  return { since: latest, fresh: feed.arrivals.filter((a) => a.arrivedAt > since) }
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

/** A badge count from chats.counts: it stops at 99, and `more` says there may be others. */
export interface Count {
  count: number
  more: boolean
}

/**
 * Whether Focused's Unread list may still be missing chats, so the inbox's next page should
 * load on its own. Unread is the unread chats among the inbox pages loaded, which come newest
 * first, so an old unread chat can be several pages in. The server counts every unread inbox
 * chat: once that many are loaded, the rest of the inbox can wait for the Read list to be
 * scrolled. Without a count (a filter is on, or it hasn't come yet), or with one that stops
 * short ("99+", or an inbox too long to count to its end), only the end of the inbox says.
 */
export function unreadIncomplete({
  more,
  loadedUnread,
  count,
}: {
  /** The inbox has pages past what's loaded, or one on its way. */
  more: boolean
  /** Loaded inbox chats that the server counts as unread: unread and not muted. */
  loadedUnread: number
  count: Count | undefined
}): boolean {
  if (!more) return false
  if (!count || count.more) return true
  return loadedUnread < count.count
}

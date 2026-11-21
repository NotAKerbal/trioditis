/** What deciding whether to mark the open chat read needs to know about it. */
export interface OpenChat {
  id: string
  /** Unread messages, from the server's count. */
  unread: number
  markedUnread: boolean
}

/**
 * What was already done for the open chat: which chat was seen open, and the unread count the
 * last mark was sent at (`chatId:count`), so the same count isn't marked twice.
 */
export interface ReadOnOpen {
  opened: string | null
  sent: string | null
}

export const NOTHING_READ: ReadOnOpen = { opened: null, sent: null }

/**
 * Whether to mark the open chat read now. Only while the person can see it (`visible`): the
 * window shown and focused, so a chat left open in the background still collects unread.
 *
 * Opening a chat, by a click or a link, marks it read, "marked unread" included. While it stays
 * open, any unread count it shows is marked read, once per count; but not if the person marked
 * it unread while it was open, which is their choice to keep.
 *
 * It goes by the count, not by the newest message: a message that arrives late can sort before
 * the newest one (the person's own copy still sending, say) and leave the preview as it was.
 * A mark that fails isn't sent again until the count changes, so a failure can't loop.
 */
export function readOnOpen(
  /** The open chat; `undefined` while it loads, `null` when none is open. */
  chat: OpenChat | null | undefined,
  visible: boolean,
  done: ReadOnOpen,
): { mark: boolean; done: ReadOnOpen } {
  // No chat open (null, not still loading): opening one again is a new opening.
  if (chat === null) return { mark: false, done: { opened: null, sent: null } }
  if (!chat) return { mark: false, done }
  // Once the count is back to 0, the next unread message is marked again, whatever its count.
  const settled = chat.unread === 0 && done.sent?.startsWith(`${chat.id}:`) ? { ...done, sent: null } : done
  if (!visible) return { mark: false, done: settled }
  const key = `${chat.id}:${chat.unread}`
  if (settled.opened !== chat.id) {
    const mark = chat.unread > 0 || chat.markedUnread
    return { mark, done: { opened: chat.id, sent: mark ? key : null } }
  }
  const mark = chat.unread > 0 && !chat.markedUnread && settled.sent !== key
  return { mark, done: mark ? { ...settled, sent: key } : settled }
}

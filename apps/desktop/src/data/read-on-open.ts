/** What deciding whether to mark the open chat read needs to know about it. */
export interface OpenChat {
  id: string
  /** Unread messages, from the server's count. */
  unread: number
  /** One more with every message counted unread (`ChatRow.unreadRev`). */
  unreadRev: number
  markedUnread: boolean
}

/**
 * What was already done for the open chat: which chat was seen open, and the unread revision
 * the last mark was sent at (`chatId:unreadRev`), so the same unread isn't marked twice.
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
 * open, any unread it shows is marked read, once per unread revision; but not if the person
 * marked it unread while it was open, which is their choice to keep.
 *
 * It goes by the revision, which every message counted unread moves on. Not by the newest
 * message: one that arrives late can sort before it (the person's own copy still sending, say)
 * and leave the preview as it was. Not by the count: marked read at 1, another can arrive
 * before the 0 is seen, and the count is 1 again. A mark that fails isn't sent again until
 * another message is counted, so a failure can't loop.
 */
export function readOnOpen(
  /** The open chat; `undefined` while it loads, `null` when none is open. */
  chat: OpenChat | null | undefined,
  visible: boolean,
  done: ReadOnOpen,
): { mark: boolean; done: ReadOnOpen } {
  // No chat open (null, not still loading): opening one again is a new opening.
  if (chat === null) return { mark: false, done: { opened: null, sent: null } }
  if (!chat || !visible) return { mark: false, done }
  const key = `${chat.id}:${chat.unreadRev}`
  if (done.opened !== chat.id) {
    const mark = chat.unread > 0 || chat.markedUnread
    return { mark, done: { opened: chat.id, sent: mark ? key : null } }
  }
  const mark = chat.unread > 0 && !chat.markedUnread && done.sent !== key
  return { mark, done: mark ? { ...done, sent: key } : done }
}

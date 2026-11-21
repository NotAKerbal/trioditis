/** What deciding whether to mark the open chat read needs to know about it. */
export interface OpenChat {
  id: string
  /** Unread messages, from the server's count. */
  unread: number
  markedUnread: boolean
  /** The newest message's ID, so a message that arrives while it's open is told apart. */
  lastMessageId: string | null
}

/** What was already done for the open chat: which chat was seen open, and the last mark sent. */
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
 * open, each new unread message marks it read again, once; but not if the person marked it
 * unread while it was open, which is their choice to keep.
 */
export function readOnOpen(
  /** The open chat; `undefined` while it loads, `null` when none is open. */
  chat: OpenChat | null | undefined,
  visible: boolean,
  done: ReadOnOpen,
): { mark: boolean; done: ReadOnOpen } {
  // No chat open (null, not still loading): opening one again is a new opening.
  if (chat === null) return { mark: false, done: { ...done, opened: null } }
  if (!chat || !visible) return { mark: false, done }
  const key = `${chat.id}:${chat.lastMessageId ?? ''}`
  if (done.opened !== chat.id) {
    const mark = chat.unread > 0 || chat.markedUnread
    return { mark, done: { opened: chat.id, sent: mark ? key : done.sent } }
  }
  const mark = chat.unread > 0 && !chat.markedUnread && done.sent !== key
  return { mark, done: mark ? { ...done, sent: key } : done }
}

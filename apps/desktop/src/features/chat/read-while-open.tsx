import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useChat, type ChatId } from '~/data/chats.ts'
import { NOTHING_READ, readOnOpen } from '~/data/read-on-open.ts'

/** Whether the window is shown and focused, as it changes: when the person can see the open chat. */
function subscribeSeen(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
}
const seen = () => document.visibilityState === 'visible' && document.hasFocus()

/** Marks an open chat read when it's opened and as messages arrive in it (data/read-on-open.ts). */
export function ReadWhileOpen({
  chatId,
  paused = false,
  markRead,
}: {
  chatId: ChatId
  /** Its messages aren't shown yet: nothing is marked, and it isn't opened until they are. */
  paused?: boolean
  markRead: (chatId: ChatId) => Promise<unknown>
}) {
  useReadWhileOpen(chatId, paused, markRead)
  return null
}

function useReadWhileOpen(chatId: ChatId, paused: boolean, markRead: (chatId: ChatId) => Promise<unknown>) {
  // The same object until the chat's row changes, so the effect runs once per change.
  const chat = useChat(chatId)
  const visible = useSyncExternalStore(subscribeSeen, seen)
  const done = useRef(NOTHING_READ)
  useEffect(() => {
    // Paused, it keeps what was done: when it goes on, the chat isn't opened again.
    if (paused) return
    const open = chat && {
      id: chat.id,
      unread: chat.unread,
      unreadRev: chat.row.unreadRev,
      markedUnread: chat.row.markedUnread,
    }
    const next = readOnOpen(open, visible, done.current)
    done.current = next.done
    if (next.mark && chat) void markRead(chat.id)
  }, [chat, visible, paused, markRead])
}

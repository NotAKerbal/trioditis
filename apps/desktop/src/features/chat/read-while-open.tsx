import { useEffect, useSyncExternalStore } from 'react'
import { useOpenChat, type ChatId } from '~/data/chats.ts'
import { NOTHING_READ, readOnOpen, type ReadOnOpen } from '~/data/read-on-open.ts'
import { useConnected } from '~/features/shell/sync-bar.tsx'

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

// The open chats whose messages are on screen now, as their trackers see them: choosing the open
// chat again marks only these read (Shell), never one still loading or held back.
const shownNow = new Set<string>()

/** Whether this chat's messages are on screen, with the server's copy of the chat. */
export const isShownNow = (chatId: string) => shownNow.has(chatId)

/** Marks an open chat read when it's opened and as messages arrive in it (data/read-on-open.ts). */
export function ReadWhileOpen({
  chatId,
  paused = false,
  states,
  markRead,
}: {
  chatId: ChatId
  /** Its messages aren't shown yet: nothing is marked, and it isn't opened until they are. */
  paused?: boolean
  /** What each chat's tracker has done, kept by the pane so a remount isn't a new opening. */
  states: Map<string, ReadOnOpen>
  markRead: (chatId: ChatId) => Promise<unknown>
}) {
  // Not while the server can't be reached either: what's on screen is then the cache's, and a
  // mark sent when it's back would count messages that came meanwhile, never shown, as read.
  // Back online, the chat on screen is caught up and marked as any open chat is.
  const connected = useConnected()
  useReadWhileOpen(chatId, paused || !connected, states, markRead)
  return null
}

function useReadWhileOpen(
  chatId: ChatId,
  paused: boolean,
  states: Map<string, ReadOnOpen>,
  markRead: (chatId: ChatId) => Promise<unknown>,
) {
  // The same object until the chat's row changes, so the effect runs once per change. The
  // sidebar's copy, shown while the server is asked, doesn't count: the chat is marked read on
  // the server's answer, never on a click alone.
  const open = useOpenChat(chatId)
  const chat = open.confirmed ? open.chat : undefined
  const visible = useSyncExternalStore(subscribeSeen, seen)
  const showing = !paused && !!chat
  useEffect(() => {
    if (!showing) return
    shownNow.add(chatId)
    return () => void shownNow.delete(chatId)
  }, [showing, chatId])
  useEffect(() => {
    // Paused, it keeps what was done: when it goes on, the chat isn't opened again.
    if (paused) return
    const open = chat && {
      id: chat.id,
      unread: chat.unread,
      unreadRev: chat.row.unreadRev,
      markedUnread: chat.row.markedUnread,
    }
    const next = readOnOpen(open, visible, states.get(chatId) ?? NOTHING_READ)
    states.set(chatId, next.done)
    if (next.mark && chat) void markRead(chat.id)
  }, [chat, chatId, visible, paused, states, markRead])
}

import { api } from '@trioditis/backend/api'
import type { ChatRow } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toChat, useChatCounts, type Chat } from '~/data/chats.ts'
import { openLastMessage } from '~/data/last-message.ts'
import { newArrivals, notificationText, type Since } from '~/data/notify.ts'
import { desktop } from '~/lib/desktop.ts'
import { usePrefs } from '~/lib/prefs.ts'
import { useSession } from '~/lib/session.tsx'

// Some browsers have notifications but can't make one from a page (Chrome on Android wants a
// service worker): the first that fails turns them off here until the page reloads.
let broken = false

/** Whether this browser can show notifications from this page, if the person allows them. */
export const notificationsAvailable = () => !broken && 'Notification' in window

/** Whether this page can show notifications: the browser makes them and the person allowed it. */
export const canNotify = () => notificationsAvailable() && Notification.permission === 'granted'

function show(title: string, options: NotificationOptions): Notification | null {
  try {
    return new Notification(title, options)
  } catch {
    broken = true
    return null
  }
}

/**
 * Shows a notification for each new message from someone else (`messages.arrivals`), and keeps
 * the desktop app's badge at the number of unread chats. The shell mounts it once; clicking a
 * notification opens its chat with `open`, as clicking it in the list does.
 */
export function useMessageNotifications(selectedId: string | undefined, open: (chat: Chat) => void) {
  const session = useSession()
  const prefs = usePrefs()
  const feed = useQuery(convexQuery(api.messages.arrivals, {})).data
  const unread = useChatCounts()?.inbox.count
  const since = useRef<Since>(undefined)
  // As of now, for the effect below and for a click that comes later.
  const latest = useRef({ selectedId, open, prefs })
  latest.current = { selectedId, open, prefs }

  useEffect(() => {
    if (!feed) return
    const { since: next, fresh } = newArrivals(since.current, feed)
    since.current = next
    const { selectedId, prefs } = latest.current
    if (!prefs.notifications || !canNotify()) return
    const notified = new Set<string>()
    for (const arrival of fresh) {
      const chat = toChat(arrival.chat as ChatRow, session)
      // One per chat, for its newest message; none for a muted chat.
      if (chat.muted || notified.has(chat.id)) continue
      notified.add(chat.id)
      // The chat the person is reading needs no notification.
      if (chat.id === selectedId && document.visibilityState === 'visible' && document.hasFocus()) continue
      const text = openLastMessage(arrival.message, session)?.text ?? null
      const { title, body } = notificationText(chat, text, prefs.notificationContent)
      // Tagged by chat: a newer message replaces the last one's notification, and another tab's.
      const notification = show(title, { body, tag: chat.id, icon: '/icon.svg' })
      if (!notification) return
      notification.onclick = () => {
        desktop?.focus()
        window.focus()
        latest.current.open(chat)
        notification.close()
      }
    }
  }, [feed, session])

  useEffect(() => {
    if (unread !== undefined) desktop?.setBadge(unread)
  }, [unread])
  // Signed out, or the app closed: no badge.
  useEffect(() => () => desktop?.setBadge(0), [])
}

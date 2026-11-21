import { useEffect, useState, useSyncExternalStore } from 'react'
import { useCancelledIn, useScheduled, useScheduledTexts, type Chat } from './chats.ts'
import { useContactProfiles } from './contacts.ts'
import { useMessages, useReactions } from './messages.ts'
import { warmList } from './warm-list.ts'

/**
 * Fetches ahead what a chat's pane will ask for when it opens on that chat alone (chat-pane.tsx):
 * its first page of messages, their reactions, a group's senders and its scheduled messages,
 * with the very same arguments, so the pane finds them in the cache. A conversation of several
 * chats asks for its other chats' pages too; this one's are here already.
 */
export function useWarmChat(chat: Chat) {
  const { messages } = useMessages(chat.id)
  useReactions(messages.filter((m) => !m.deleted && !m.pending))
  const group = chat.row.kind === 'group'
  useContactProfiles(chat.network, group ? messages.flatMap((m) => (m.ghostId && !m.self ? [m.ghostId] : [])) : [])
  const scheduledRows = useScheduled(chat.id)
  const cancelledRows = useCancelledIn([chat.id])
  const pending = (scheduledRows ?? []).filter((s) => s.state !== 'failed' && s.chatId === chat.id)
  useScheduledTexts([...pending, ...(cancelledRows ?? [])].map((s) => s._id))
}

/** How long the messages wait, once they're here, for what's shown alongside them. */
export const SETTLE_MS = 400

/**
 * Whether the messages can show: once they've loaded and what's shown with them (reactions,
 * senders' names, scheduled messages) has too, or SETTLE_MS after the messages came, whichever
 * is first. Shown together, nothing arrives a moment later to push the list about. Once shown,
 * it stays shown: what changes afterwards is live, not loading.
 */
export function useSettled(loaded: boolean, extrasPending: boolean, wait = SETTLE_MS) {
  const [settled, setSettled] = useState(false)
  const ready = loaded && !extrasPending
  useEffect(() => {
    if (settled || !loaded) return
    if (ready) return setSettled(true)
    const timer = setTimeout(() => setSettled(true), wait)
    return () => clearTimeout(timer)
  }, [settled, loaded, ready, wait])
  return settled || ready
}

// Chats fetched ahead: the one the pointer rests on or a key has focused, and the likeliest to be
// opened next. Each stays subscribed while listed here; once let go, the cache (main.tsx) keeps
// what it fetched for a few minutes more, so opening it is instant either way.

/** At most this many chats fetched ahead at once: each is a few live queries on the server. */
const warm = warmList<Chat>(6)

/** Fetches a chat ahead, most recent first; the oldest beyond the limit is let go. */
export const warmChat = (chat: Chat) => warm.add(chat)

/** The chats fetched ahead now. */
export function useWarmChats(): readonly Chat[] {
  return useSyncExternalStore(warm.subscribe, warm.get)
}

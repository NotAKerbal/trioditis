import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useCancelledScheduled, useScheduled, useScheduledTexts, type Chat } from './chats.ts'
import { useContactProfiles } from './contacts.ts'
import { useMessages, useReactions } from './messages.ts'
import { warmList } from './warm-list.ts'

/**
 * What an open chat shows from the server: its messages, their reactions, a group's senders and
 * its scheduled messages. The open pane and a chat fetched ahead (WarmChats) ask through this one
 * hook, so they ask the very same queries, and a chat fetched ahead opens from the cache.
 */
export function useChatContent(chat: Chat, attempt = 0) {
  const page = useMessages(chat.id, attempt)
  const { messages } = page
  // Deleted messages and pending copies have no reactions: leaving them out saves requests for
  // nothing, and keeps the reaction groups steady (a pending copy's place can still move).
  const reacting = useMemo(() => messages.filter((m) => !m.deleted && !m.pending), [messages])
  const reactions = useReactions(chat.id, reacting)
  // Only a group's senders are shown, so only a group asks who they are.
  const group = chat.row.kind === 'group'
  const senders = useContactProfiles(
    chat.network,
    group ? messages.flatMap((m) => (m.ghostId && !m.self ? [m.ghostId] : [])) : [],
  )
  const scheduledRows = useScheduled(chat.id)
  const cancelledRows = useCancelledScheduled(chat.id)
  // Only those still to go: a failed one's chat was gone, and the sidebar lists it to dismiss.
  const pendingScheduled = useMemo(() => (scheduledRows ?? []).filter((s) => s.state !== 'failed'), [scheduledRows])
  const scheduledTexts = useScheduledTexts([...pendingScheduled, ...(cancelledRows ?? [])].map((s) => s._id))
  return {
    ...page,
    serverReactions: reactions.reactions,
    senders: senders.profiles,
    pendingScheduled,
    cancelledRows,
    scheduledTexts,
    /** Something shown alongside the messages is still on its way. */
    extrasPending:
      reactions.pending || senders.pending || scheduledRows === undefined || cancelledRows === undefined,
  }
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

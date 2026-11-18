import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import type { ChatRow, ChatView, Network, SidebarLayout } from '@trioditis/core'
import { DEFAULT_PREFERENCES, NETWORK_INFO } from '@trioditis/core'
import { toast } from '@trioditis/ui/toast'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useMemo } from 'react'
import { errorMessage } from '~/lib/errors.ts'
import {
  tryOpen,
  type ChatPlaintext,
  type LabelColor,
  type LabelPlaintext,
  type MessagePlaintext,
} from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'

export type ChatId = Id<'chats'>
export type LabelId = Id<'labels'>

/** A chat as the app shows it: its sealed metadata opened on this device. */
export interface Chat {
  id: ChatId
  row: ChatRow
  network: Network
  name: string
  topic: string | undefined
  /** False until the bridge host has described the chat (or if this device can't open it). */
  described: boolean
  unread: number
  /** Shown as unread: unread messages, or marked unread by the person. */
  hasUnread: boolean
  mentions: number
  muted: boolean
}

export const networkName = (network: string) => NETWORK_INFO[network as Network]?.name ?? network

// Opened metadata, by chat and ciphertext, so re-renders don't decrypt everything again.
const metaCache = new Map<string, ChatPlaintext | null>()

function openMeta(row: ChatRow, session: Session): ChatPlaintext | null {
  if (!row.sealedMeta) return null
  const key = `${row._id}:${row.sealedMeta.ct}`
  if (!metaCache.has(key))
    metaCache.set(key, tryOpen<ChatPlaintext>(row.sealedMeta, session.keyPair, 'chat', session.userId, row.portalId))
  return metaCache.get(key) ?? null
}

export function toChat(row: ChatRow, session: Session, now = Date.now()): Chat {
  const meta = openMeta(row, session)
  const where = networkName(row.network)
  const muted = (row.mutedUntil ?? 0) > now
  return {
    id: row._id as ChatId,
    row,
    network: row.network,
    name: meta?.name?.trim() || (row.kind === 'dm' ? `Chat on ${where}` : `Group on ${where}`),
    topic: meta?.topic,
    described: !!meta,
    unread: row.unreadCount,
    hasUnread: row.unreadCount > 0 || row.markedUnread,
    mentions: row.mentionCount,
    muted,
  }
}

export interface ChatFilter {
  network?: Network | undefined
  labelId?: LabelId | undefined
}

export interface ChatList {
  /** `undefined` while the first page loads (or when the list isn't needed). */
  chats: Chat[] | undefined
  /** More chats exist past what's loaded: show "50+" and load on scroll. */
  canLoadMore: boolean
  loadMore: () => void
}

/**
 * One view of the chat list, a page at a time: the first page starts with the view's pinned
 * chats, then the rest newest first (client-api.md, The list).
 */
export function useChats(view: ChatView, filter: ChatFilter = {}, enabled = true): ChatList {
  const session = useSession()
  const args = {
    view,
    ...(filter.network ? { network: filter.network } : {}),
    ...(filter.labelId ? { labelId: filter.labelId } : {}),
  }
  const { results, status, loadMore } = usePaginatedQuery(api.chats.list, enabled ? args : 'skip', {
    initialNumItems: 50,
  })
  const chats = useMemo(
    () =>
      !enabled || status === 'LoadingFirstPage' ? undefined : results.map((row) => toChat(row as ChatRow, session)),
    [enabled, status, results, session],
  )
  return { chats, canLoadMore: status === 'CanLoadMore', loadMore: () => loadMore(50) }
}

export function useChat(chatId: ChatId | undefined): Chat | null | undefined {
  const session = useSession()
  const { data, isError } = useQuery({
    ...convexQuery(api.chats.get, { chatId: chatId! }),
    enabled: !!chatId,
    retry: false,
  })
  return useMemo(() => {
    if (!chatId || isError) return null
    return data ? toChat(data as ChatRow, session) : undefined
  }, [chatId, data, isError, session])
}

export function useChatCounts() {
  return useQuery(convexQuery(api.chats.counts, {})).data
}

/** Runs a mutation and shows its error, as a sentence, instead of throwing. */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, fallback: string) {
  return async (...args: A) => {
    try {
      await fn(...args)
      return true
    } catch (e) {
      toast(errorMessage(e, fallback))
      return false
    }
  }
}

export function useChatActions() {
  const markRead = useMutation(api.chats.markRead)
  const markUnread = useMutation(api.chats.markUnread)
  const setArchived = useMutation(api.chats.setArchived)
  const setPinned = useMutation(api.chats.setPinned)
  const setMuted = useMutation(api.chats.setMuted)
  const snooze = useMutation(api.chats.snooze)
  const wake = useMutation(api.chats.wake)
  const acceptRequest = useMutation(api.chats.acceptRequest)
  const setBlocked = useMutation(api.chats.setBlocked)
  const setLabels = useMutation(api.chats.setLabels)
  return useMemo(
    () => ({
      markRead: guarded((chatId: ChatId) => markRead({ chatId }), 'That chat couldn’t be marked read.'),
      markUnread: guarded((chatId: ChatId) => markUnread({ chatId }), 'That chat couldn’t be marked unread.'),
      setArchived: guarded(
        (chatId: ChatId, archived: boolean) => setArchived({ chatId, archived }),
        'That chat couldn’t be archived.',
      ),
      setPinned: guarded(
        (chatId: ChatId, pinned: boolean) => setPinned({ chatId, pinned }),
        'That chat couldn’t be pinned.',
      ),
      setMuted: guarded(
        (chatId: ChatId, muted: boolean, until?: number) => setMuted({ chatId, muted, ...(until ? { until } : {}) }),
        'That chat couldn’t be muted.',
      ),
      snooze: guarded((chatId: ChatId, until: number) => snooze({ chatId, until }), 'That chat couldn’t be snoozed.'),
      wake: guarded((chatId: ChatId) => wake({ chatId }), 'That chat couldn’t be woken.'),
      acceptRequest: guarded((chatId: ChatId) => acceptRequest({ chatId }), 'That request couldn’t be accepted.'),
      setBlocked: guarded(
        (chatId: ChatId, blocked: boolean) => setBlocked({ chatId, blocked }),
        'That chat couldn’t be blocked.',
      ),
      setLabels: guarded(
        (chatId: ChatId, labelIds: LabelId[]) => setLabels({ chatId, labelIds }),
        'Those labels couldn’t be saved.',
      ),
    }),
    [markRead, markUnread, setArchived, setPinned, setMuted, snooze, wake, acceptRequest, setBlocked, setLabels],
  )
}

export interface Label {
  id: LabelId
  labelKey: string
  name: string
  color: LabelColor
}

/** The person's labels, opened on this device. */
export function useLabels(): Label[] | undefined {
  const session = useSession()
  const { data } = useQuery(convexQuery(api.labels.list, {}))
  return useMemo(
    () =>
      data?.flatMap((row) => {
        const label = tryOpen<LabelPlaintext>(row.sealed, session.keyPair, 'label', session.userId, row.labelKey)
        return label ? [{ id: row._id, labelKey: row.labelKey, name: label.name, color: label.color }] : []
      }),
    [data, session],
  )
}

/** The sidebar layout follows the person across devices. Simple until they choose. */
export function useSidebarLayout(): [SidebarLayout, (layout: SidebarLayout) => void] {
  const { data } = useQuery(convexQuery(api.preferences.get, {}))
  const set = useMutation(api.preferences.set).withOptimisticUpdate((store, { sidebarLayout }) => {
    if (sidebarLayout) store.setQuery(api.preferences.get, {}, { sidebarLayout })
  })
  const layout = data?.sidebarLayout ?? DEFAULT_PREFERENCES.sidebarLayout
  return [
    layout,
    (sidebarLayout) =>
      void set({ sidebarLayout }).catch((e: unknown) => toast(errorMessage(e, 'That setting couldn’t be saved.'))),
  ]
}

export function useNetworks() {
  return useQuery(convexQuery(api.networks.list, {})).data
}

export function useNetworkHealth() {
  return useQuery(convexQuery(api.networks.health, {})).data
}

export function useAccounts() {
  return useQuery(convexQuery(api.logins.accounts, {})).data
}

export function useScheduled(chatId?: ChatId) {
  return useQuery(convexQuery(api.scheduled.list, chatId ? { chatId } : {})).data
}

/**
 * The person's sealed copies of scheduled messages, opened on this device, by scheduled ID.
 * `scheduled.list` carries no content; copies come at most 20 at a time.
 */
export function useScheduledTexts(ids: Id<'scheduledSends'>[]): Map<string, string> {
  const session = useSession()
  const first = ids.slice(0, 20)
  const { data } = useQuery({
    ...convexQuery(api.scheduled.copies, { scheduledIds: first }),
    enabled: first.length > 0,
  })
  const clientIds = useScheduled()
  return useMemo(() => {
    const out = new Map<string, string>()
    for (const row of data ?? []) {
      const clientMessageId = clientIds?.find((s) => s._id === row._id)?.clientMessageId
      if (!clientMessageId) continue
      const body = tryOpen<MessagePlaintext>(
        row.copy,
        session.keyPair,
        'message',
        session.userId,
        clientMessageId,
      )?.body
      if (body !== undefined) out.set(row._id, body)
    }
    return out
  }, [data, clientIds, session])
}

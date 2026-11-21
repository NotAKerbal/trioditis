import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import type { AccountPlaintext, Attachment, ChatRow, ChatView, Network, SidebarLayout } from '@trioditis/core'
import { DEFAULT_PREFERENCES, NETWORK_INFO } from '@trioditis/core'
import { toast } from '@trioditis/ui/toast'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useMemo } from 'react'
import { liveHealth, useHeardClock, useNow } from '~/data/bridge-liveness.ts'
import { checkWithinAYear } from '~/data/snooze.ts'
import type { LastShown } from '~/features/shell/row-preview.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import {
  openCached,
  tryOpen,
  type ChatPlaintext,
  type LabelColor,
  type LabelPlaintext,
  type MessagePlaintext,
} from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'
import type { PersonRef } from './conversations.ts'
import { openLastMessage } from './last-message.ts'

export type ChatId = Id<'chats'>
export type LabelId = Id<'labels'>

/** A chat as the app shows it: its sealed metadata opened on this device. */
export interface Chat {
  id: ChatId
  row: ChatRow
  network: Network
  /** Its name, or what it is and where (`Chat on WhatsApp`) when that isn't known yet. */
  name: string
  /** Whether `name` is the chat's own. */
  named: boolean
  topic: string | undefined
  /** Its picture, to decrypt and show (data/media.ts). */
  avatar: Attachment | undefined
  /** The network the picture is fetched through, when it isn't the chat's own (a conversation's). */
  avatarNetwork?: Network | undefined
  /** False until the bridge host has described the chat (or if this device can't open it). */
  described: boolean
  unread: number
  /** Shown as unread: unread messages, or marked unread by the person. */
  hasUnread: boolean
  mentions: number
  muted: boolean
  /** The last message, opened here, for the list's preview; null until the row has one. */
  last: LastShown | null
  /** In a direct chat, the other person's contact on its network, once the bridge host has said. */
  dmGhostId: string | undefined
  /**
   * The People card a direct chat is with. On a conversation that puts a person's direct chats
   * on several networks together (conversations.ts), the chats themselves are `members`, the
   * newest first, and the rest of the fields sum them up.
   */
  person?: PersonRef | undefined
  members?: Chat[] | undefined
}

/** The chats a row or pane stands for: a conversation's members, or the chat itself. */
export const membersOf = (chat: Chat): Chat[] => chat.members ?? [chat]

/**
 * Runs an action on each chat of a conversation, all at once. True if every one went: each
 * says its own failure.
 */
export async function onEach(chats: readonly Chat[], run: (chatId: ChatId) => Promise<boolean>) {
  const done = await Promise.all(chats.map((c) => run(c.id)))
  return done.every(Boolean)
}

/**
 * One conversation for a person's direct chats: named and pictured after their card, unread if
 * any of them is, muted if all are, and showing the newest message of any. It goes by the first
 * chat's ID, so opening it opens that chat, and the pane finds the rest (conversations.ts).
 */
export function mergedChat(members: readonly Chat[], person: PersonRef | undefined): Chat {
  const first = members[0]!
  if (members.length < 2) return person ? { ...first, person } : first
  const newest = members.reduce((a, b) => ((b.last?.at ?? 0) > (a.last?.at ?? 0) ? b : a))
  const sum = (f: (c: Chat) => number) => members.reduce((n, c) => n + f(c), 0)
  const pictured = members.find((c) => c.avatar)
  return {
    ...first,
    row: {
      ...first.row,
      pinned: members.some((c) => c.row.pinned),
      markedUnread: members.some((c) => c.row.markedUnread),
      unreadCount: sum((c) => c.row.unreadCount),
      mentionCount: sum((c) => c.row.mentionCount),
      labelIds: [...new Set(members.flatMap((c) => c.row.labelIds))],
      lastMessageAt: Math.max(...members.map((c) => c.row.lastMessageAt)),
    },
    name: person?.name || first.name,
    named: !!person?.name || first.named,
    // The first chat's picture, or another's, fetched through that chat's network.
    avatar: pictured?.avatar,
    avatarNetwork: pictured?.network,
    described: members.some((c) => c.described),
    unread: sum((c) => c.unread),
    hasUnread: members.some((c) => c.hasUnread),
    mentions: sum((c) => c.mentions),
    muted: members.every((c) => c.muted),
    last: newest.last,
    person,
    members: [...members],
  }
}

/** Live rows for these chats, in order, leaving out any that's gone; undefined while any loads. */
export function useChatsById(ids: readonly ChatId[]): Chat[] | undefined {
  const session = useSession()
  const answers = useQueries({
    queries: ids.map((chatId) => ({ ...convexQuery(api.chats.get, { chatId }), retry: false })),
    combine: rowsOf,
  })
  return useMemo(() => {
    if (answers.some((a) => a.pending)) return undefined
    return answers.flatMap((a) => (a.row ? [toChat(a.row as ChatRow, session)] : []))
  }, [answers, session])
}
// Outside the hook, so useQueries can keep its result while the answers don't change.
const rowsOf = (results: { data?: unknown; isPending: boolean }[]) =>
  results.map((r) => ({ row: r.data ?? null, pending: r.isPending }))

export const networkName = (network: string) => NETWORK_INFO[network as Network]?.name ?? network

// Opened chat metadata (openCached), so re-renders don't decrypt every row again.
const metaCache = new Map<string, ChatPlaintext | null>()

function openMeta(row: ChatRow, session: Session): ChatPlaintext | null {
  return openCached(metaCache, row.sealedMeta, session.keyPair, session.kid, 'chat', session.userId, row.portalId)
}

// Each chat's last picture, for metadata that says it's unchanged without carrying it
// (sealing.md, Message plaintext). Only what this page has seen: a fresh page has none until
// the picture comes again.
const lastAvatar = new Map<string, Attachment>()

/** The picture metadata carries, or the one it last carried when it says it's unchanged. */
export function avatarOf(
  key: string,
  meta: Pick<ChatPlaintext, 'avatar' | 'avatarUnchanged'> | null,
  kept = lastAvatar,
): Attachment | undefined {
  if (!meta) return undefined
  if (meta.avatar) kept.set(key, meta.avatar)
  else if (!meta.avatarUnchanged) kept.delete(key)
  return kept.get(key)
}

export function toChat(row: ChatRow, session: Session, now = Date.now()): Chat {
  const meta = openMeta(row, session)
  const own = meta?.name?.trim()
  const where = networkName(row.network)
  const muted = (row.mutedUntil ?? 0) > now
  return {
    id: row._id as ChatId,
    row,
    network: row.network,
    name: own || (row.kind === 'dm' ? `Chat on ${where}` : `Group on ${where}`),
    named: !!own,
    topic: meta?.topic,
    avatar: avatarOf(`${session.userId}/${row._id}`, meta),
    described: !!meta,
    unread: row.unreadCount,
    hasUnread: row.unreadCount > 0 || row.markedUnread,
    mentions: row.mentionCount,
    muted,
    last: openLastMessage(row.lastMessage, session),
    dmGhostId: row.kind === 'dm' && typeof meta?.dmGhostId === 'string' ? meta.dmGhostId : undefined,
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
  /** Every chat in the view is loaded: not while a page is still on its way. */
  exhausted: boolean
  loadMore: () => void
}

/**
 * One view of the chat list, a page at a time: the pinned chats, then the rest, each newest
 * first (or newest first alone, with `order: 'recent'`), paged as one list, so pins can carry on past the first page and the server never
 * repeats one (client-api.md, The list). The rows are shown as they come, in order.
 */
export function useChats(view: ChatView, filter: ChatFilter = {}, enabled = true, order?: 'recent'): ChatList {
  const session = useSession()
  const args = {
    view,
    ...(filter.network ? { network: filter.network } : {}),
    ...(filter.labelId ? { labelId: filter.labelId } : {}),
    ...(order ? { order } : {}),
  }
  const { results, status, loadMore } = usePaginatedQuery(api.chats.list, enabled ? args : 'skip', {
    initialNumItems: 50,
  })
  const chats = useMemo(
    () =>
      !enabled || status === 'LoadingFirstPage' ? undefined : results.map((row) => toChat(row as ChatRow, session)),
    [enabled, status, results, session],
  )
  return {
    chats,
    canLoadMore: status === 'CanLoadMore',
    exhausted: enabled && status === 'Exhausted',
    loadMore: () => loadMore(50),
  }
}

export function useChat(chatId: ChatId | undefined): Chat | null | undefined {
  const session = useSession()
  // 'skip', not `enabled: false`: the Convex adapter subscribes to any query it's given.
  const { data, isError } = useQuery({
    ...convexQuery(api.chats.get, chatId ? { chatId } : 'skip'),
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
      setMuted: guarded((chatId: ChatId, muted: boolean, until?: number) => {
        if (until !== undefined) checkWithinAYear(until)
        return setMuted({ chatId, muted, ...(until !== undefined ? { until } : {}) })
      }, 'That chat couldn’t be muted.'),
      snooze: guarded((chatId: ChatId, until: number) => {
        checkWithinAYear(until)
        return snooze({ chatId, until })
      }, 'That chat couldn’t be snoozed.'),
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
  const session = useSession()
  const { data } = useQuery(convexQuery(api.preferences.get, {}))
  const set = useMutation(api.preferences.set).withOptimisticUpdate((store, { sidebarLayout }) => {
    if (sidebarLayout) store.setQuery(api.preferences.get, {}, { sidebarLayout })
  })
  const layout = data?.sidebarLayout ?? DEFAULT_PREFERENCES.sidebarLayout
  return [
    layout,
    (sidebarLayout) =>
      // Saved for the session the page opened with; for another, the page starts again instead.
      void set({ sidebarLayout, sessionId: session.sessionId }).catch((e: unknown) =>
        sessionChanged(e) ? window.location.reload() : toast(errorMessage(e, 'That setting couldn’t be saved.')),
      ),
  ]
}

/** What this server offers: whether it's a demo, and whether it takes invitations (server.info). */
export function useServerInfo() {
  return useQuery(convexQuery(api.server.info, {})).data
}

export function useNetworks() {
  return useQuery(convexQuery(api.networks.list, {})).data
}

/** Each network's health, with its bridge judged again as time passes (data/bridge-liveness.ts). */
export function useNetworkHealth() {
  const rows = useQuery(convexQuery(api.networks.health, {})).data
  const clock = useHeardClock()
  const now = useNow()
  return useMemo(() => (rows ? liveHealth(rows, clock, now) : rows), [rows, clock, now])
}

type AccountRow = FunctionReturnType<typeof api.logins.accounts>[number]
// Opened account hints (openCached), so re-renders don't decrypt every row again.
const accountCache = new Map<string, AccountPlaintext | null>()

/**
 * An account's hint as its bridge host put it (its number or username, sealed to the person),
 * or the backend's own (the end of its ID) where this device can't open one.
 */
export function openAccountHint(row: AccountRow, session: Session): string {
  const meta = row.sealedMeta
  const opened = meta
    ? openCached(accountCache, meta.sealed, session.keyPair, session.kid, 'account', session.userId, meta.objectId)
    : null
  return typeof opened?.hint === 'string' && opened.hint ? opened.hint : row.hint
}

export function useAccounts() {
  const session = useSession()
  const rows = useQuery(convexQuery(api.logins.accounts, {})).data
  return useMemo(() => rows?.map((row) => ({ ...row, hint: openAccountHint(row, session) })), [rows, session])
}

export function useScheduled(chatId?: ChatId) {
  return useQuery(convexQuery(api.scheduled.list, chatId ? { chatId } : {})).data
}

/** Cancelled scheduled messages kept on the server until restored or discarded (scheduled.cancelled). */
export function useCancelledScheduled(chatId?: ChatId) {
  return useQuery(convexQuery(api.scheduled.cancelled, chatId ? { chatId } : {})).data
}

type ScheduledCopy = FunctionReturnType<typeof api.scheduled.copies>[number]
// Outside the hook, so useQueries can keep its result while the answers don't change.
const copiesOf = (results: { data?: ScheduledCopy[] | undefined; isError: boolean }[]) =>
  results.map((r) => ({ rows: r.data, failed: r.isError }))

/**
 * The person's sealed copies of scheduled messages, opened on this device, by scheduled ID.
 * `scheduled.list` carries no content; copies are asked for 20 at a time, the most it takes.
 */
export function useScheduledTexts(ids: Id<'scheduledSends'>[]): Map<string, string | null> {
  const session = useSession()
  const batches: Id<'scheduledSends'>[][] = []
  for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20))
  const answers = useQueries({
    queries: batches.map((scheduledIds) => convexQuery(api.scheduled.copies, { scheduledIds })),
    combine: copiesOf,
  })
  const scheduledIds = useScheduled()
  const cancelledIds = useCancelledScheduled()
  const clientIds = useMemo(() => [...(scheduledIds ?? []), ...(cancelledIds ?? [])], [scheduledIds, cancelledIds])
  return useMemo(() => {
    // Text once opened; null for a copy that doesn't open here or couldn't be fetched (it can
    // still be cancelled, with nothing to put back); missing while it loads.
    const out = new Map<string, string | null>()
    answers.forEach((answer, i) => {
      if (answer.failed) for (const id of batches[i] ?? []) out.set(id, null)
    })
    for (const row of answers.flatMap((answer) => answer.rows ?? [])) {
      const clientMessageId = clientIds.find((s) => s._id === row._id)?.clientMessageId
      if (!clientMessageId) continue
      const body = tryOpen<MessagePlaintext>(
        row.copy,
        session.keyPair,
        'message',
        session.userId,
        clientMessageId,
      )?.body
      out.set(row._id, body ?? null)
    }
    return out
    // `batches` follows `ids`, which `answers` already reflects.
  }, [answers, clientIds, session])
}

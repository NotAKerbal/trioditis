import { api } from '@trioditis/backend/api'
import type { Doc, Id } from '@trioditis/backend/dataModel'
import type { DeliveryState } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
// The cached hook keeps a chat's pages subscribed for a while after its pane closes (main.tsx),
// so going back to a chat shows its latest messages at once, already up to date, instead of
// loading. Earlier pages it had loaded aren't put back: the list starts from the newest again.
import { usePaginatedQuery as useCachedPaginatedQuery } from 'convex-helpers/react/cache/hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openCached, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'
import type { ChatId } from './chats.ts'
import type { BridgeStatus } from './bridge-ready.ts'
import { reactionGroups, reactionRequests, showReactions, type Shown } from './reaction-requests.ts'
import { CONFIRM_MS, confirmed, sameKey, withPending, type PendingReaction, type Reaction } from './reaction-toggle.ts'

export interface Message {
  id: Id<'messages'>
  eventId: string
  /** Still the person's pending copy: not echoed by the network yet. */
  pending: boolean
  self: boolean
  ghostId: string | undefined
  at: number
  /** The opened content: the latest edit if there is one. Null if deleted or unopenable. */
  body: MessagePlaintext | null
  edited: boolean
  deleted: boolean
  replyTo: string | undefined
  clientMessageId: string | undefined
  delivery: DeliveryState | undefined
}

const bodyCache = new Map<string, MessagePlaintext | null>()

function openBody(m: Doc<'messages'>, session: Session): MessagePlaintext | null {
  const envelope = m.sealedEdit ?? m.sealed
  const objectId = m.sealedEdit ? m.editEventId! : m.sealedObjectId
  return openCached(bodyCache, envelope, session.keyPair, session.kid, 'message', session.userId, objectId)
}

function toMessage(m: Doc<'messages'>, session: Session): Message {
  return {
    id: m._id,
    eventId: m.eventId,
    pending: m.eventId.startsWith('pending:'),
    self: 'self' in m.sender,
    ghostId: 'ghostId' in m.sender ? m.sender.ghostId : undefined,
    at: m.networkTs,
    body: m.redactedAt ? null : openBody(m, session),
    edited: !!m.sealedEdit,
    deleted: m.redactedAt !== undefined,
    replyTo: m.replyTo,
    clientMessageId: m.clientMessageId,
    delivery: m.delivery,
  }
}

const PAGE = 50

/**
 * A chat's messages, oldest first for display, loading older pages on request. `attempt` counts
 * the retries after a page couldn't load (RetryBoundary). The cached hook keeps a page's
 * subscription, its error too, for minutes after it's let go, under a key made from its
 * arguments (its pagination ID is always 0): asked again the same way, a failed page fails
 * again, and every page it keeps is asked again at once when the connection comes back. So a
 * retry uses Convex's own hook instead, which asks under a new pagination ID each time it mounts
 * and lets its pages go as soon as it unmounts.
 */
export function useMessages(chatId: ChatId, attempt = 0) {
  const session = useSession()
  const retrying = attempt > 0
  const cached = useCachedPaginatedQuery(api.messages.list, retrying ? 'skip' : { chatId }, { initialNumItems: PAGE })
  const fresh = usePaginatedQuery(api.messages.list, retrying ? { chatId } : 'skip', { initialNumItems: PAGE })
  const { results, status, loadMore } = retrying ? fresh : cached
  const messages = useMemo(() => [...results].reverse().map((m) => toMessage(m, session)), [results, session])
  return {
    messages,
    loading: status === 'LoadingFirstPage',
    canLoadMore: status === 'CanLoadMore',
    loadingMore: status === 'LoadingMore',
    loadMore: () => loadMore(PAGE),
  }
}

type ReactionAnswer = Record<string, { key: string; senderKey: string }[]>
const MAX_REACTIONS_PER_MESSAGE = 100

export type { Reaction }
// Outside the hook, so useQueries can keep its result while the answers don't change.
const resultsOf = (results: { data?: ReactionAnswer | undefined; isPending: boolean; isError: boolean }[]) =>
  results.map((r) => ({ data: r.data, pending: r.isPending, failed: r.isError }))
// A request replaced by another (its group moved) stops being watched soon after, not in minutes.
const REACTIONS_GC_MS = 10_000

/**
 * Reactions on the loaded messages (oldest first, pending copies left out), grouped by key with
 * who reacted. They're asked for in groups that stay put as the list grows, 100 at most, and
 * again for any an answer didn't reach (reaction-requests.ts): each request's answer is read from
 * the cache, so the requests grow as answers come. While a group's new request is on its way, its
 * messages keep what they showed, for a few seconds at most (showReactions).
 */
export function useReactions(chatId: ChatId, messages: { id: Id<'messages'>; at: number }[]) {
  const queryClient = useQueryClient()
  const request = (asked: Id<'messages'>[]) => convexQuery(api.messages.reactions, { chatId, messageIds: asked })
  const answerFor = (asked: Id<'messages'>[]) => queryClient.getQueryData<ReactionAnswer>(request(asked).queryKey)
  const requests = reactionGroups(messages).flatMap((group) => reactionRequests(group, answerFor))
  const results = useQueries({
    queries: requests.map((asked) => ({ ...request(asked), gcTime: REACTIONS_GC_MS })),
    combine: resultsOf,
  })
  const before = useRef(new Map<string, Shown<ReactionAnswer[string]>>())
  // Bumped when a kept list runs out, to show what's true then.
  const [tick, setTick] = useState(0)
  const ids = messages.map((m) => m.id).join()
  const asked = requests.map((r) => r.join()).join('|')
  // `tick` is a dependency so it looks again when a kept list runs out.
  const { shown, expires } = useMemo(() => {
    // A failed request counts as neither an answer nor one on its way, even with data from
    // before it failed. A live one's answer stays current: its watch would bring any change.
    const fresh = new Map<string, ReactionAnswer[string]>()
    const waiting = new Set<string>()
    results.forEach((r, i) => {
      if (r.failed) return
      if (r.data) for (const [id, list] of Object.entries(r.data)) fresh.set(id, list)
      else if (r.pending) for (const id of asked.split('|')[i]?.split(',') ?? []) waiting.add(id)
    })
    return showReactions(ids ? ids.split(',') : [], fresh, waiting, before.current, Date.now())
  }, [results, ids, asked, tick])
  useEffect(() => {
    before.current = shown
    if (expires === null) return
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, expires - Date.now()) + 20)
    return () => clearTimeout(timer)
  }, [shown, expires])
  const data = useMemo(() => Object.fromEntries([...shown].map(([id, s]) => [id, s.list])) as ReactionAnswer, [shown])
  // Some of these messages have had no answer yet.
  const pending = results.some((r) => r.pending)
  const reactions = useMemo(() => {
    const out = new Map<string, Reaction[]>()
    for (const [messageId, list] of Object.entries(data)) {
      // The server gives a message's first 100 reactions at most: at that, any count may be more.
      const more = list.length >= MAX_REACTIONS_PER_MESSAGE
      const byKey = new Map<string, Reaction>()
      for (const r of list) {
        const entry = byKey.get(r.key) ?? { key: r.key, count: 0, more, mine: false }
        entry.count++
        if (r.senderKey === 'self') entry.mine = true
        byKey.set(r.key, entry)
      }
      out.set(messageId, [...byKey.values()])
    }
    return out
  }, [data])
  return { reactions, pending }
}

/**
 * The reactions to show, the person's own choices laid over the server's until its echo says
 * the same (reaction-toggle.ts), and `toggle`, which adds the person's reaction with that key or
 * takes it away. One the network hasn't confirmed in CONFIRM_MS goes back to what the server
 * says, and `onUnconfirmed` is told; one the server refused goes back at once, with its error.
 */
export function useReactionToggle(
  chatId: ChatId,
  server: Map<string, Reaction[]>,
  onUnconfirmed: () => void,
  onError: (e: unknown) => void,
) {
  const react = useMutation(api.messages.react)
  const [pending, setPending] = useState<PendingReaction[]>([])
  const live = useMemo(() => pending.filter((p) => !confirmed(p, server)), [pending, server])
  useEffect(() => {
    if (live.length !== pending.length) setPending(live)
  }, [live, pending.length])
  const onUnconfirmedRef = useRef(onUnconfirmed)
  onUnconfirmedRef.current = onUnconfirmed
  const oldest = live.length ? Math.min(...live.map((p) => p.at)) : null
  useEffect(() => {
    if (oldest === null) return
    const timer = setTimeout(
      () => {
        const now = Date.now()
        setPending((list) => list.filter((p) => now - p.at < CONFIRM_MS))
        onUnconfirmedRef.current()
      },
      Math.max(0, oldest + CONFIRM_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [oldest])
  const shown = useMemo(() => withPending(server, live), [server, live])
  const toggle = useCallback(
    (messageId: Id<'messages'>, key: string) => {
      // A change still on its way can't be undone yet: the bridge host may not have the
      // reaction to take away until it has added it. The choice shows as made meanwhile.
      if (live.some((q) => q.messageId === messageId && sameKey(q.key, key))) return
      const remove = !!shown.get(messageId)?.some((r) => r.mine && sameKey(r.key, key))
      const p: PendingReaction = { messageId, key, remove, at: Date.now() }
      const others = (q: PendingReaction) => q.messageId !== messageId || !sameKey(q.key, key)
      setPending((list) => [...list.filter(others), p])
      react({ chatId, messageId, key, ...(remove ? { remove } : {}) }).catch((e: unknown) => {
        setPending((list) => list.filter((q) => q !== p))
        onError(e)
      })
    },
    [live, shown, react, chatId, onError],
  )
  return { reactions: shown, toggle }
}

/** Who is typing now. Queries don't rerun as time passes, so expiry is checked here. */
export function useTyping(chatId: ChatId) {
  const { data } = useQuery(convexQuery(api.messages.typing, { chatId }))
  const [now, setNow] = useState(() => Date.now())
  const next = Math.min(...(data ?? []).map((t) => t.expiresAt).filter((t) => t > now), Infinity)
  useEffect(() => {
    if (next === Infinity) return
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [next])
  return (data ?? []).filter((t) => t.expiresAt > now)
}

/** The bridge's public key, once there is one, and where it stands (see bridge-ready.ts). */
export function useBridge(): { key: string | undefined; status: BridgeStatus } {
  const { data, isPending, isError } = useQuery(convexQuery(api.keys.bridge, {}))
  if (isPending) return { key: undefined, status: 'loading' }
  if (isError) return { key: undefined, status: 'error' }
  return data?.publicKey ? { key: data.publicKey, status: 'ready' } : { key: undefined, status: 'missing' }
}

/**
 * Where sending each of these sends again stands, by client message ID, as the server decides
 * it (messages.retryStates): the same for every send of a chain.
 */
export function useRetryStates(clientMessageIds: string[]) {
  const { data } = useQuery({
    ...convexQuery(api.messages.retryStates, { clientMessageIds }),
    enabled: clientMessageIds.length > 0,
  })
  return data
}

export function useSendMutations() {
  return {
    send: useMutation(api.messages.send),
    sendAgain: useMutation(api.messages.sendAgain),
    discard: useMutation(api.messages.discardSend),
    schedule: useMutation(api.scheduled.create),
    cancelScheduled: useMutation(api.scheduled.cancel),
    forgetScheduled: useMutation(api.scheduled.forget),
    sendScheduledNow: useMutation(api.scheduled.sendNow),
  }
}

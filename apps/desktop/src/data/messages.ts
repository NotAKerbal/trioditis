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
  /** The chat it's in: one of a conversation's, when the pane shows several (conversations.ts). */
  chatId: ChatId
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
    chatId: m.chatId as ChatId,
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
 * One chat's pages. The cached hook keeps a page's subscription, its error too, for minutes
 * after it's let go, under a key made from its arguments (its pagination ID is always 0): asked
 * again the same way, a failed page fails again, and every page it keeps is asked again at once
 * when the connection comes back. So a retry (`retrying`, after RetryBoundary caught a page that
 * couldn't load) uses Convex's own hook instead, which asks under a new pagination ID each time
 * it mounts and lets its pages go as soon as it unmounts.
 */
function usePage(chatId: ChatId | undefined, retrying: boolean) {
  const cached = useCachedPaginatedQuery(api.messages.list, chatId && !retrying ? { chatId } : 'skip', {
    initialNumItems: PAGE,
  })
  const fresh = usePaginatedQuery(api.messages.list, chatId && retrying ? { chatId } : 'skip', {
    initialNumItems: PAGE,
  })
  return retrying ? fresh : cached
}

/**
 * The messages of a chat, or of every chat of a conversation together (at most MAX_MERGED),
 * oldest first for display, loading older pages on request. `attempt` counts the retries after a
 * page couldn't load (RetryBoundary; see usePage).
 *
 * Each chat pages on its own, so their pages reach back to different times. Only what every
 * chat has loaded back to is shown together (`mergePages`): older messages of one wait until
 * the others have loaded back that far, so nothing appears out of place and then has another
 * chat's messages arrive in between. Loading more loads more of each that has more.
 */
export function useMessages(chatIds: ChatId | readonly (ChatId | undefined)[], attempt = 0) {
  const session = useSession()
  const retrying = attempt > 0
  // One page per slot, always as many: an empty slot is skipped. A chat keeps its slot as the
  // conversation's order changes (stableSlots), so its pages aren't loaded again from the start.
  const ids = typeof chatIds === 'string' ? [chatIds] : chatIds
  const all = [
    usePage(ids[0], retrying),
    usePage(ids[1], retrying),
    usePage(ids[2], retrying),
    usePage(ids[3], retrying),
    usePage(ids[4], retrying),
    usePage(ids[5], retrying),
  ]
  const slots = all.flatMap((p, i) => (ids[i] ? [{ ...p, chatId: ids[i] }] : []))
  const statuses = slots.map((p) => `${p.chatId}:${p.status}`).join()
  const { messages, hidden } = useMemo(() => {
    const chats = slots.map((p) => ({
      chatId: p.chatId,
      messages: [...p.results].reverse().map((m) => toMessage(m, session)),
      more: p.status === 'CanLoadMore' || p.status === 'LoadingMore',
    }))
    const horizon = horizonOf(chats)
    return {
      messages: mergePages(chats),
      // Chats whose loaded messages are all from before what's shown: none of theirs is on screen.
      hidden: chats.flatMap((c) => (c.messages.length && c.messages.at(-1)!.at < horizon ? [c.chatId] : [])),
    }
    // A slot's results are the same array until its page changes; every slot is listed, so the
    // list is as long whatever the number of chats.
  }, [session, statuses, ...all.map((p) => p.results)])
  return {
    messages,
    hidden,
    loading: slots.some((p) => p.status === 'LoadingFirstPage'),
    canLoadMore: slots.some((p) => p.status === 'CanLoadMore'),
    loadingMore: slots.some((p) => p.status === 'LoadingMore'),
    loadMore: () => {
      for (const p of slots) if (p.status === 'CanLoadMore') p.loadMore(PAGE)
    },
  }
}

/** How far back merged chats are shown: the oldest loaded message of the latest-reaching chat with more. */
export function horizonOf(chats: readonly { messages: readonly { at: number }[]; more: boolean }[]): number {
  if (chats.length === 1) return -Infinity
  return Math.max(-Infinity, ...chats.flatMap((c) => (c.more && c.messages.length ? [c.messages[0]!.at] : [])))
}

/**
 * Several chats' loaded messages (each oldest first) as one list, oldest first. A chat with
 * more to load sets how far back the list goes: its oldest loaded message. Each chat keeps its
 * own order, and they're merged by time.
 */
export function mergePages<M extends { at: number }>(chats: readonly { messages: readonly M[]; more: boolean }[]): M[] {
  if (chats.length === 1) return [...chats[0]!.messages]
  const horizon = horizonOf(chats)
  const lists = chats.map((c) => c.messages.filter((m) => m.at >= horizon))
  const at = lists.map(() => 0)
  const out: M[] = []
  for (;;) {
    let pick = -1
    for (let i = 0; i < lists.length; i++) {
      const m = lists[i]![at[i]!]
      if (m && (pick < 0 || m.at < lists[pick]![at[pick]!]!.at)) pick = i
    }
    if (pick < 0) return out
    out.push(lists[pick]![at[pick]!]!)
    at[pick]!++
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
export function useReactions(messages: { id: Id<'messages'>; at: number; chatId: ChatId }[]) {
  const queryClient = useQueryClient()
  const request = (chatId: ChatId, asked: Id<'messages'>[]) =>
    convexQuery(api.messages.reactions, { chatId, messageIds: asked })
  // Asked chat by chat: each request is for one chat's messages.
  const byChat = new Map<ChatId, typeof messages>()
  for (const m of messages) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m])
  const requests = [...byChat].flatMap(([chatId, list]) =>
    reactionGroups(list).flatMap((group) =>
      reactionRequests(group, (asked) => queryClient.getQueryData<ReactionAnswer>(request(chatId, asked).queryKey)).map(
        (asked) => ({ chatId, asked }),
      ),
    ),
  )
  const results = useQueries({
    queries: requests.map((r) => ({ ...request(r.chatId, r.asked), gcTime: REACTIONS_GC_MS })),
    combine: resultsOf,
  })
  const before = useRef(new Map<string, Shown<ReactionAnswer[string]>>())
  // Bumped when a kept list runs out, to show what's true then.
  const [tick, setTick] = useState(0)
  const ids = messages.map((m) => m.id).join()
  const asked = requests.map((r) => r.asked.join()).join('|')
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
  return useMemo(() => {
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
}

/**
 * The reactions to show, the person's own choices laid over the server's until its echo says
 * the same (reaction-toggle.ts), and `toggle`, which adds the person's reaction with that key or
 * takes it away. One the network hasn't confirmed in CONFIRM_MS goes back to what the server
 * says, and `onUnconfirmed` is told; one the server refused goes back at once, with its error.
 */
export function useReactionToggle(
  /** The chat each message is in. */
  chatIdOf: (messageId: Id<'messages'>) => ChatId | undefined,
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
  const chatIdOfRef = useRef(chatIdOf)
  chatIdOfRef.current = chatIdOf
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
      const chatId = chatIdOfRef.current(messageId)
      if (!chatId) return
      const remove = !!shown.get(messageId)?.some((r) => r.mine && sameKey(r.key, key))
      const p: PendingReaction = { messageId, key, remove, at: Date.now() }
      const others = (q: PendingReaction) => q.messageId !== messageId || !sameKey(q.key, key)
      setPending((list) => [...list.filter(others), p])
      react({ chatId, messageId, key, ...(remove ? { remove } : {}) }).catch((e: unknown) => {
        setPending((list) => list.filter((q) => q !== p))
        onError(e)
      })
    },
    [live, shown, react, onError],
  )
  return { reactions: shown, toggle }
}

// Outside the hook, so useQueries can keep its result while the answers don't change.
const typingOf = (results: { data?: { expiresAt: number }[] | undefined }[]) => results.flatMap((r) => r.data ?? [])

/** Who is typing now, in any of these chats. Queries don't rerun as time passes, so expiry is checked here. */
export function useTyping(chatIds: readonly ChatId[]) {
  const data = useQueries({
    queries: chatIds.map((chatId) => convexQuery(api.messages.typing, { chatId })),
    combine: typingOf,
  })
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

import { api } from '@trioditis/backend/api'
import type { Doc, Id } from '@trioditis/backend/dataModel'
import type { DeliveryState } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { openCached, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'
import type { ChatId } from './chats.ts'
import type { BridgeStatus } from './bridge-ready.ts'
import { reactionGroups, reactionRequests } from './reaction-requests.ts'

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

/** A chat's messages, oldest first for display, loading older pages on request. */
export function useMessages(chatId: ChatId) {
  const session = useSession()
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, { chatId }, { initialNumItems: 50 })
  const messages = useMemo(() => [...results].reverse().map((m) => toMessage(m, session)), [results, session])
  return {
    messages,
    loading: status === 'LoadingFirstPage',
    canLoadMore: status === 'CanLoadMore',
    loadMore: () => loadMore(50),
  }
}

type ReactionAnswer = Record<string, { key: string; senderKey: string }[]>
const MAX_REACTIONS_PER_MESSAGE = 100

/** One reaction on a message, with how many gave it: `more` when there may be others unseen. */
export interface Reaction {
  key: string
  count: number
  more: boolean
  mine: boolean
}
// Outside the hook, so useQueries can keep its result while the answers don't change.
const answersOf = (results: { data?: ReactionAnswer | undefined }[]) => results.map((r) => r.data)

/**
 * Reactions on the loaded messages (oldest first), grouped by key with who reacted. They're asked
 * for in groups that stay put as the list grows, 100 at most, and again for any an answer didn't
 * reach (reaction-requests.ts): each request's answer is read from the cache, so the requests
 * grow as answers come. While a group's request is new, its messages keep what they last showed.
 */
export function useReactions(chatId: ChatId, messages: { id: Id<'messages'>; at: number }[]) {
  const queryClient = useQueryClient()
  const request = (asked: Id<'messages'>[]) => convexQuery(api.messages.reactions, { chatId, messageIds: asked })
  const answerFor = (asked: Id<'messages'>[]) => queryClient.getQueryData<ReactionAnswer>(request(asked).queryKey)
  const requests = reactionGroups(messages).flatMap((group) => reactionRequests(group, answerFor))
  const answers = useQueries({ queries: requests.map(request), combine: answersOf })
  const shown = useRef<ReactionAnswer>({})
  const ids = messages.map((m) => m.id).join()
  const data = useMemo(() => {
    const fresh: ReactionAnswer = Object.assign({}, ...answers.filter(Boolean))
    const out: ReactionAnswer = {}
    for (const id of ids ? ids.split(',') : []) {
      const list = fresh[id] ?? shown.current[id]
      if (list) out[id] = list
    }
    return out
  }, [answers, ids])
  useEffect(() => {
    shown.current = data
  }, [data])
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

export function useSendMutations() {
  return {
    send: useMutation(api.messages.send),
    discard: useMutation(api.messages.discardSend),
    schedule: useMutation(api.scheduled.create),
    cancelScheduled: useMutation(api.scheduled.cancel),
    sendScheduledNow: useMutation(api.scheduled.sendNow),
  }
}

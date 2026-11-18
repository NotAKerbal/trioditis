import { api } from '@trioditis/backend/api'
import type { Doc, Id } from '@trioditis/backend/dataModel'
import type { DeliveryState } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useEffect, useMemo, useState } from 'react'
import { openCached, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'
import type { ChatId } from './chats.ts'
import { reactionRequests } from './reaction-requests.ts'

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
 * Reactions on the loaded messages, grouped by key with who reacted. They're asked for 100
 * messages at a time, and again for any an answer didn't reach (reaction-requests.ts): each
 * request's answer is read from the cache, so the requests grow as answers come.
 */
export function useReactions(chatId: ChatId, messageIds: Id<'messages'>[]) {
  const queryClient = useQueryClient()
  const request = (asked: Id<'messages'>[]) => convexQuery(api.messages.reactions, { chatId, messageIds: asked })
  const requests = reactionRequests(messageIds, (asked) =>
    queryClient.getQueryData<ReactionAnswer>(request(asked).queryKey),
  )
  const answers = useQueries({ queries: requests.map(request), combine: answersOf })
  return useMemo(() => {
    const out = new Map<string, Reaction[]>()
    const data: ReactionAnswer = Object.assign({}, ...answers.filter(Boolean))
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
  }, [answers])
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

/** The bridge's public key: undefined while it loads, null when the server has none (see bridge-ready.ts). */
export function useBridgeKey(): string | null | undefined {
  const { data, isPending } = useQuery(convexQuery(api.keys.bridge, {}))
  return isPending ? undefined : (data?.publicKey ?? null)
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

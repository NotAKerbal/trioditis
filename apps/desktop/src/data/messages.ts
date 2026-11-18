import { api } from '@trioditis/backend/api'
import type { Doc, Id } from '@trioditis/backend/dataModel'
import type { DeliveryState } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useEffect, useMemo, useState } from 'react'
import { tryOpen, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession, type Session } from '~/lib/session.tsx'
import type { ChatId } from './chats.ts'

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
  if (!envelope) return null
  const objectId = m.sealedEdit ? m.editEventId! : m.sealedObjectId
  const key = `${m._id}:${envelope.ct}`
  if (!bodyCache.has(key))
    bodyCache.set(key, tryOpen<MessagePlaintext>(envelope, session.keyPair, 'message', session.userId, objectId))
  return bodyCache.get(key) ?? null
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

/** Reactions on the loaded messages, grouped by key with who reacted. */
export function useReactions(chatId: ChatId, messageIds: Id<'messages'>[]) {
  const ids = messageIds.slice(-100)
  const { data } = useQuery({
    ...convexQuery(api.messages.reactions, { chatId, messageIds: ids }),
    enabled: ids.length > 0,
  })
  return useMemo(() => {
    const out = new Map<string, { key: string; count: number; mine: boolean }[]>()
    for (const [messageId, list] of Object.entries(data ?? {})) {
      const byKey = new Map<string, { key: string; count: number; mine: boolean }>()
      for (const r of list) {
        const entry = byKey.get(r.key) ?? { key: r.key, count: 0, mine: false }
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

export function useBridgeKey() {
  return useQuery(convexQuery(api.keys.bridge, {})).data?.publicKey ?? null
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

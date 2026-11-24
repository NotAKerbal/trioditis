import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import { NETWORK_INFO, type DeliveryState, type Network } from '@trioditis/core'
import type { Envelope } from '@trioditis/crypto'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newClientId } from '~/lib/sealed.ts'
import type { ChatId } from './chats.ts'
import type { Message } from './messages.ts'

// The person's edits and deletions show at once, before the network has them: an edit's new text
// is laid over the message until the server shows it, and a message being deleted is marked so.
// Neither is ever sent again on its own after an unclear outcome; the person is told, and can
// edit or delete again (client-api.md, Sending).

/** Whether a message is one of the person's that reached the network and is still there. */
const ownSent = (m: Message) => m.self && !m.pending && !m.deleted && !m.deleting

const within = (m: Message, maxAgeMs: number | null, now: number) => maxAgeMs === null || now - m.at <= maxAgeMs

/**
 * Whether the person can change this message's text now: their own plain text message (one with
 * a file or cut short isn't), on a network that edits, inside its time limit and its cap on
 * edits (messages.edit).
 */
export function canEditMessage(m: Message, network: Network, now: number): boolean {
  const limit = NETWORK_INFO[network]?.edit
  const body = m.body
  return (
    !!limit &&
    ownSent(m) &&
    !!body &&
    body.type === 'text' &&
    !!body.body &&
    !body.attachments?.length &&
    !body.truncated &&
    (limit.maxEdits === undefined || m.edits < limit.maxEdits) &&
    within(m, limit.maxAgeMs, now)
  )
}

/** Whether the person can delete this message now (messages.remove). */
export function canDeleteMessage(m: Message, network: Network, now: number): boolean {
  const limit = NETWORK_INFO[network]?.delete
  return !!limit && ownSent(m) && within(m, limit.maxAgeMs, now)
}

/** An edit sent from here, not yet shown by the server. */
export interface PendingEdit {
  messageId: Id<'messages'>
  clientMessageId: string
  text: string
  /** When the server said the network has it, if it has. */
  sentAt?: number
}

/** A deletion asked for here, not yet shown by the server. */
export interface PendingDelete {
  messageId: Id<'messages'>
  at: number
}

/**
 * How long an edit the network has may wait for its text to show (its echo comes with its
 * outcome, so only a network that changed the text on the way keeps it waiting).
 */
export const EDIT_SHOWN_MS = 5_000
/** How long a message shows as being deleted while the network hasn't confirmed it. */
export const DELETE_CONFIRM_MS = 30_000

export type Settled = 'failed' | 'unknown' | 'unconfirmed'

/**
 * Which pending edits and deletions still show, and which ended without happening, and how
 * (`failed`: refused or ran out of time; `unknown`: may or may not have been made; `unconfirmed`:
 * a deletion the network hasn't confirmed in time). `next` is when to look again.
 */
export function settle(
  edits: readonly PendingEdit[],
  deletes: readonly PendingDelete[],
  messages: ReadonlyMap<string, Message>,
  states: ReadonlyMap<string, DeliveryState>,
  now: number,
) {
  const ended: { kind: 'edit' | 'delete'; how: Settled }[] = []
  let next: number | null = null
  const later = (at: number) => (next = Math.min(next ?? Infinity, at))
  const keptEdits = edits.flatMap((e): PendingEdit[] => {
    const m = messages.get(e.messageId)
    // Gone from the list, deleted, or showing the new text already: nothing left to lay over it.
    if (!m || m.deleted || (m.edited && m.body?.body === e.text)) return []
    const state = states.get(e.clientMessageId)
    if (state === 'failed' || state === 'unknown') {
      ended.push({ kind: 'edit', how: state })
      return []
    }
    if (state === 'sent' || state === 'delivered' || state === 'read') {
      const sentAt = e.sentAt ?? now
      if (now - sentAt >= EDIT_SHOWN_MS) return []
      later(sentAt + EDIT_SHOWN_MS)
      // The same object once it's marked, so an unchanged list is seen to be unchanged.
      return [e.sentAt === undefined ? { ...e, sentAt } : e]
    }
    return [e]
  })
  const keptDeletes = deletes.flatMap((d): PendingDelete[] => {
    const m = messages.get(d.messageId)
    if (!m || m.deleted) return []
    if (now - d.at >= DELETE_CONFIRM_MS) {
      ended.push({ kind: 'delete', how: 'unconfirmed' })
      return []
    }
    later(d.at + DELETE_CONFIRM_MS)
    return [d]
  })
  return { edits: keptEdits, deletes: keptDeletes, ended, next }
}

/** The messages with the pending edits and deletions laid over them. */
export function withChanges(
  messages: readonly Message[],
  edits: readonly PendingEdit[],
  deletes: readonly PendingDelete[],
): Message[] {
  if (!edits.length && !deletes.length) return messages as Message[]
  const editOf = new Map(edits.map((e) => [e.messageId as string, e]))
  const deleting = new Set<string>(deletes.map((d) => d.messageId))
  return messages.map((m) => {
    const e = editOf.get(m.id)
    let out = m
    if (e) out = { ...out, body: { type: 'text', body: e.text }, edited: true, editing: true }
    if (deleting.has(m.id)) out = { ...out, deleting: true }
    return out
  })
}

/**
 * The person's edits and deletions in a chat pane: `messages` with them laid over, `edit` and
 * `remove` to make one, and `say` told of one that ended without happening.
 */
export function useMessageChanges(
  messages: readonly Message[],
  /** Seals an edit's new text for the bridge host, or null when there's no bridge key yet. */
  sealEdit: (text: string, clientMessageId: string) => Envelope | null,
  say: (ended: { kind: 'edit' | 'delete'; how: Settled }) => void,
  onError: (e: unknown, kind: 'edit' | 'delete') => void,
) {
  const editMutation = useMutation(api.messages.edit)
  const removeMutation = useMutation(api.messages.remove)
  const [edits, setEdits] = useState<PendingEdit[]>([])
  const [deletes, setDeletes] = useState<PendingDelete[]>([])
  const ids = edits.map((e) => e.clientMessageId)
  const { data } = useQuery({
    ...convexQuery(api.messages.editStates, { clientMessageIds: ids }),
    enabled: ids.length > 0,
  })
  const states = useMemo(() => new Map((data ?? []).map((s) => [s.clientMessageId, s.delivery])), [data])
  const byId = useMemo(() => new Map(messages.map((m) => [m.id as string, m])), [messages])
  const [tick, setTick] = useState(0)
  const sayRef = useRef(say)
  sayRef.current = say
  useEffect(() => {
    const out = settle(edits, deletes, byId, states, Date.now())
    for (const e of out.ended) sayRef.current(e)
    if (out.edits.length !== edits.length || out.edits.some((e, i) => e !== edits[i])) setEdits(out.edits)
    if (out.deletes.length !== deletes.length) setDeletes(out.deletes)
    if (out.next === null) return
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, out.next - Date.now()) + 20)
    return () => clearTimeout(timer)
  }, [edits, deletes, byId, states, tick])
  const shown = useMemo(() => withChanges(messages, edits, deletes), [messages, edits, deletes])

  const edit = useCallback(
    (m: Message, text: string) => {
      const clientMessageId = newClientId()
      const forBridge = sealEdit(text, clientMessageId)
      if (!forBridge) return false
      const pending: PendingEdit = { messageId: m.id, clientMessageId, text }
      // A newer edit of the same message replaces the one shown.
      setEdits((list) => [...list.filter((e) => e.messageId !== m.id), pending])
      editMutation({ chatId: m.chatId, messageId: m.id, clientMessageId, forBridge }).catch((e: unknown) => {
        setEdits((list) => list.filter((p) => p !== pending))
        onError(e, 'edit')
      })
      return true
    },
    [sealEdit, editMutation, onError],
  )
  const remove = useCallback(
    (m: Message) => {
      const pending: PendingDelete = { messageId: m.id, at: Date.now() }
      setDeletes((list) => [...list.filter((d) => d.messageId !== m.id), pending])
      removeMutation({ chatId: m.chatId as ChatId, messageId: m.id }).catch((e: unknown) => {
        setDeletes((list) => list.filter((d) => d !== pending))
        onError(e, 'delete')
      })
    },
    [removeMutation, onError],
  )
  return { messages: shown, edit, remove }
}

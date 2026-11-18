import { ConvexError, type Infer } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { envelope } from '../validators'
import { MAX_CLIENT_SEALED_BYTES, isEnvelope } from './envelope'
import { sortKey } from './ingest'
import { noteMessage } from './lastMessage'
import { queueCommand } from './outbox'

// Sending a message: the checks every send goes through, and turning it into the person's
// pending copy plus an outbox command. A direct send and a scheduled one, when its time comes,
// both end up here.

/** A send still waiting to go out after this asks the person first. */
export const SEND_EXPIRY_MS = 24 * 60 * 60 * 1000

const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{16,64}$/

export interface SendInput {
  clientMessageId: string
  forBridge: Infer<typeof envelope>
  copy: Infer<typeof envelope>
  replyTo?: string
}

/** Whether `clientMessageId` has been used by this person, as a send or a scheduled send. */
export async function clientMessageIdUsed(ctx: QueryCtx, userId: string, clientMessageId: string) {
  const sent = await ctx.db
    .query('outbox')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
  if (sent) return true
  const scheduled = await ctx.db
    .query('scheduledSends')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
  return scheduled !== null
}

/** Refuses a send that can't go out as given. */
export async function checkSend(ctx: QueryCtx, chat: Doc<'chats'>, input: SendInput) {
  if (!CLIENT_MESSAGE_ID.test(input.clientMessageId)) throw new ConvexError('That message ID isn’t valid.')
  if (!isEnvelope(input.forBridge, MAX_CLIENT_SEALED_BYTES) || !isEnvelope(input.copy, MAX_CLIENT_SEALED_BYTES)) {
    throw new ConvexError('That message isn’t sealed, or is too long.')
  }
  // A reply must quote a message in this chat that reached the network.
  if (input.replyTo !== undefined) {
    const replyTo = input.replyTo
    if (replyTo.length > 256 || replyTo.startsWith('pending:'))
      throw new ConvexError('That message can’t be replied to.')
    const quoted = await ctx.db
      .query('messages')
      .withIndex('by_event', (q) => q.eq('userId', chat.userId).eq('network', chat.network).eq('eventId', replyTo))
      .unique()
    if (!quoted || quoted.chatId !== chat._id || quoted.redactedAt !== undefined) {
      throw new ConvexError('That message can’t be replied to.')
    }
  }
}

/**
 * Queues a send that has passed `checkSend`: the person's pending copy and the outbox command.
 * Its 24-hour deadline starts now.
 */
export async function queueSend(ctx: MutationCtx, chat: Doc<'chats'>, input: SendInput) {
  const now = Date.now()
  const pendingId = `pending:${input.clientMessageId}`
  const copy = {
    userId: chat.userId,
    chatId: chat._id,
    network: chat.network,
    eventId: pendingId,
    networkTs: now,
    sortKey: sortKey(now, pendingId),
    sender: { self: true as const },
    sealed: input.copy,
    sealedObjectId: input.clientMessageId,
    historical: false,
    clientMessageId: input.clientMessageId,
    delivery: 'queued' as const,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
  await noteMessage(ctx, chat, { _id: await ctx.db.insert('messages', copy), ...copy })
  await queueCommand(
    ctx,
    {
      userId: chat.userId,
      network: chat.network,
      loginId: chat.loginId,
      chatId: chat._id,
      payload: {
        type: 'send',
        portalId: chat.portalId,
        clientMessageId: input.clientMessageId,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      },
      state: 'queued',
      attempts: 0,
      delivery: 'queued',
      clientMessageId: input.clientMessageId,
      createdAt: now,
      expiresAt: now + SEND_EXPIRY_MS,
    },
    input.forBridge,
  )
  await ctx.db.patch(chat._id, { lastMessageAt: Math.max(chat.lastMessageAt, now) })
}

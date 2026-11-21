import { ConvexError, v, type Infer } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { deliveryState, type envelope } from '../validators'
import { MAX_CLIENT_SEALED_BYTES, isEnvelope } from './envelope'
import { sortKey } from './ingest'
import { noteMessage } from './lastMessage'
import { queueCommand } from './outbox'
import { RETRY_PREFIX } from './retry'

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

/**
 * What a `clientMessageId` was already used for, as `messages.send` and `scheduled.create`
 * return it when it was: a send, with its delivery state (the copy's, or the outbox's once
 * that copy was discarded; null only for a send from before the outbox kept it), or a
 * scheduled send that hasn't gone out, with where it stands.
 */
export const alreadyUsed = v.union(
  v.object({ already: v.literal('send'), delivery: v.union(v.null(), deliveryState) }),
  v.object({
    already: v.literal('scheduled'),
    state: v.union(v.literal('scheduled'), v.literal('cancelled'), v.literal('failed')),
  }),
)
export type AlreadyUsed = Infer<typeof alreadyUsed>

/**
 * What `clientMessageId` has been used for by this person, or null if nothing yet. A
 * scheduled send that has gone out was a send too, and says so.
 */
export async function clientMessageIdUsed(
  ctx: QueryCtx,
  userId: string,
  clientMessageId: string,
): Promise<AlreadyUsed | null> {
  const sent = await ctx.db
    .query('outbox')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
  if (sent) {
    const copy = await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
      .first()
    // A discarded copy's state is still the outbox's: it's kept in step with the copy.
    return { already: 'send', delivery: copy?.delivery ?? sent.delivery ?? null }
  }
  const scheduled = await ctx.db
    .query('scheduledSends')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
  if (!scheduled) return null
  // `sent` has its outbox row, found above; one in between still counts as pending.
  const state = scheduled.state === 'cancelled' || scheduled.state === 'failed' ? scheduled.state : 'scheduled'
  return { already: 'scheduled', state }
}

/**
 * Refuses a client message ID in the namespace of attempts made by `messages.sendAgain`
 * (lib/retry.ts): only that makes them, so a chain's next ID can't be taken by an ordinary send
 * or schedule first.
 */
export function refuseRetryId(clientMessageId: string) {
  if (clientMessageId.startsWith(RETRY_PREFIX)) throw new ConvexError('That message ID isn’t valid.')
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
export async function queueSend(
  ctx: MutationCtx,
  chat: Doc<'chats'>,
  input: SendInput,
  /** For an attempt made with `messages.sendAgain` (lib/retry.ts). */
  retry?: { root: string; of: string; index: number },
) {
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
      ...(retry ? { retryRoot: retry.root, retryOf: retry.of, retryIndex: retry.index } : {}),
    },
    input.forBridge,
  )
  await ctx.db.patch(chat._id, { lastMessageAt: Math.max(chat.lastMessageAt, now) })
}

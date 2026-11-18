import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { isEnvelope } from './lib/envelope'
import { queueCommand } from './lib/outbox'
import { sortKey } from './lib/ingest'
import { envelope } from './validators'

/** A send still waiting to go out after this asks the person first. */
const SEND_EXPIRY_MS = 24 * 60 * 60 * 1000

const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{16,64}$/

/** A chat's messages, newest first, a page at a time. Content is sealed. */
export const list = query({
  args: { chatId: v.id('chats'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { chatId, paginationOpts }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    return await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
      .order('desc')
      .paginate(paginationOpts)
  },
})

/**
 * Sends a message. The client seals it twice: once to the bridge key (`forBridge`, kind
 * `outbound`, object ID `clientMessageId`), which the bridge host opens to send it, and once
 * to the person's own recipients (`copy`, kind `message`, object ID `clientMessageId`), which
 * is what Trioditis keeps until the network's echo replaces it.
 *
 * `clientMessageId` makes the send idempotent end to end: sending the same ID again does
 * nothing. Retrying a failed or unknown send uses a new ID, which the person chooses to do.
 */
export const send = mutation({
  args: {
    chatId: v.id('chats'),
    clientMessageId: v.string(),
    forBridge: envelope,
    copy: envelope,
    replyTo: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, args.chatId)
    if (!CLIENT_MESSAGE_ID.test(args.clientMessageId)) throw new ConvexError('That message ID isn’t valid.')
    if (!isEnvelope(args.forBridge) || !isEnvelope(args.copy)) throw new ConvexError('That message isn’t sealed.')
    const existing = await ctx.db
      .query('outbox')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', member.userId).eq('clientMessageId', args.clientMessageId))
      .first()
    if (existing) return null

    const now = Date.now()
    await ctx.db.insert('messages', {
      userId: member.userId,
      chatId: chat._id,
      network: chat.network,
      eventId: `pending:${args.clientMessageId}`,
      networkTs: now,
      sortKey: sortKey(now, `pending:${args.clientMessageId}`),
      sender: { self: true },
      sealed: args.copy,
      sealedObjectId: args.clientMessageId,
      historical: false,
      clientMessageId: args.clientMessageId,
      delivery: 'queued',
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    })
    await queueCommand(
      ctx,
      {
        userId: member.userId,
        network: chat.network,
        loginId: chat.loginId,
        chatId: chat._id,
        payload: {
          type: 'send',
          portalId: chat.portalId,
          clientMessageId: args.clientMessageId,
          ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        },
        state: 'queued',
        attempts: 0,
        delivery: 'queued',
        clientMessageId: args.clientMessageId,
        createdAt: now,
        expiresAt: now + SEND_EXPIRY_MS,
      },
      args.forBridge,
    )
    await ctx.db.patch(chat._id, { lastMessageAt: Math.max(chat.lastMessageAt, now) })
    return null
  },
})

/**
 * Discards a send whose outcome is unknown or that failed: the person decided not to risk a
 * duplicate. Its pending copy is removed; the outbox row stays for the record.
 */
export const discardSend = mutation({
  args: { clientMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { clientMessageId }) => {
    const member = await requireMember(ctx)
    const message = await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', member.userId).eq('clientMessageId', clientMessageId))
      .first()
    if (!message) return null
    if (message.delivery !== 'unknown' && message.delivery !== 'failed') {
      throw new ConvexError('Only a message that failed or may not have sent can be discarded.')
    }
    if (!message.eventId.startsWith('pending:')) {
      throw new ConvexError('This message reached the network, so it can’t be discarded here.')
    }
    await ctx.db.delete(message._id)
    return null
  },
})

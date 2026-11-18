import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { byteSize } from './lib/bounded'
import { checkSend, clientMessageIdUsed, queueSend } from './lib/send'
import { envelope } from './validators'

/** The most messages one page holds. */
const MAX_PAGE_ITEMS = 100
/** The most one page reads, well under a query's 16 MiB limit. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024

/** A chat's messages, newest first, a page at a time. Content is sealed. */
export const list = query({
  args: { chatId: v.id('chats'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { chatId, paginationOpts }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    // A page holds what the client asks for, up to a size the server bounds: messages can be
    // large (a capped original plus its latest edit), so a page ends early rather than
    // failing. The client keeps loading with the returned cursor.
    return await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(Math.max(1, paginationOpts.numItems), MAX_PAGE_ITEMS),
        maximumBytesRead: Math.min(paginationOpts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
      })
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
  handler: async (ctx, { chatId, ...input }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    // Sending the same message again does nothing, whatever has changed since.
    if (await clientMessageIdUsed(ctx, member.userId, input.clientMessageId)) return null
    await checkSend(ctx, chat, input)
    await queueSend(ctx, chat, input)
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

/** The most reactions shown per message. */
const MAX_REACTIONS_PER_MESSAGE = 100
/** The most `messages.reactions` reads of reaction rows, well under a query's 16 MiB. */
const MAX_REACTION_BYTES = 8 * 1024 * 1024
/**
 * The largest a reaction row can be: its key, event ID, sender and user ID are each capped
 * at 256 characters at ingest (`MAX_ID_LENGTH`), up to 3 bytes each in UTF-8, plus IDs.
 */
const MAX_REACTION_ROW_BYTES = 4 * 1024

/**
 * Active reactions on the given messages (at most 100 messages, 100 reactions each). It never
 * reads the messages themselves, which can be large: a reaction row says whose it is, and a
 * deleted message's reactions are hidden by its clean-up marker until they're removed.
 *
 * It reads at most `MAX_REACTION_BYTES` of reactions, starting a message only while a full
 * one's worth of the largest rows still fits, so messages it didn't get to are left out of
 * the result, as a deleted one still being cleaned up is. Every other message gets a list,
 * empty if it has no reactions (or isn't the person's).
 */
export const reactions = query({
  args: { chatId: v.id('chats'), messageIds: v.array(v.id('messages')) },
  handler: async (ctx, { chatId, messageIds }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    if (messageIds.length > 100) throw new ConvexError('Ask for at most 100 messages’ reactions at once.')
    const out: Record<string, { key: string; senderKey: string }[]> = {}
    let bytes = 0
    for (const messageId of messageIds) {
      if (MAX_REACTION_BYTES - bytes < MAX_REACTIONS_PER_MESSAGE * MAX_REACTION_ROW_BYTES) break
      const deleted = await ctx.db
        .query('reactionCleanups')
        .withIndex('by_message', (q) => q.eq('messageId', messageId))
        .first()
      if (deleted) {
        // A deleted message in this chat is left out; one in another chat isn't this chat's,
        // so it gets an empty list like any other ID that isn't a message here.
        if (deleted.chatId !== undefined && deleted.chatId !== chatId) out[messageId] = []
        continue
      }
      const rows = await ctx.db
        .query('reactions')
        .withIndex('by_message_active', (q) => q.eq('messageId', messageId).eq('removedAt', undefined))
        .take(MAX_REACTIONS_PER_MESSAGE)
      bytes += byteSize(rows)
      out[messageId] = rows
        .filter((row) => row.userId === member.userId && row.chatId === chatId && row.removedAt === undefined)
        .map(({ key, senderKey }) => ({ key, senderKey }))
    }
    return out
  },
})

/** How far each participant has read in a chat: `senderKey` is `self` or `ghost:<ghostId>`. */
export const receipts = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    const rows = await ctx.db
      .query('receipts')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(500)
    return rows.map(({ senderKey, upToEventId, networkTs }) => ({ senderKey, upToEventId, networkTs }))
  },
})

/**
 * Who is typing in a chat. Each row says until when; the client hides rows once `expiresAt`
 * has passed, since a query doesn't rerun just because time passes.
 */
export const typing = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    const now = Date.now()
    const rows = await ctx.db
      .query('typing')
      .withIndex('by_chat_expires', (q) => q.eq('chatId', chatId).gt('expiresAt', now))
      .take(100)
    return rows.map(({ senderKey, expiresAt }) => ({ senderKey, expiresAt }))
  },
})

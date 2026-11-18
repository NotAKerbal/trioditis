import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { checkSend, clientMessageIdUsed, queueSend } from './lib/send'
import { envelope } from './validators'

// Scheduled sends: a message to go out at `sendAt`, in its chat (and so on its network). When
// the time comes it becomes an ordinary send, and its 24-hour deadline starts then. Until then
// the bridge-readable copy waits in `scheduledSends`, deleted once it goes out or is cancelled.

const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000
const MAX_SCHEDULED = 500

const scheduledRow = v.object({
  _id: v.id('scheduledSends'),
  chatId: v.id('chats'),
  clientMessageId: v.string(),
  sendAt: v.number(),
  /** The person's own copy, sealed with kind `message` and object ID `clientMessageId`. */
  copy: v.union(v.null(), envelope),
  replyTo: v.union(v.null(), v.string()),
})

function toRow(row: Doc<'scheduledSends'>) {
  return {
    _id: row._id,
    chatId: row.chatId,
    clientMessageId: row.clientMessageId,
    sendAt: row.sendAt,
    copy: row.copy ?? null,
    replyTo: row.replyTo ?? null,
  }
}

/** The person's scheduled messages, soonest first; in one chat if `chatId` is given. */
export const list = query({
  args: { chatId: v.optional(v.id('chats')) },
  returns: v.array(scheduledRow),
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    if (chatId) {
      await ownChat(ctx, member.userId, chatId)
      const rows = await ctx.db
        .query('scheduledSends')
        .withIndex('by_chat', (q) => q.eq('chatId', chatId).eq('state', 'scheduled'))
        .take(MAX_SCHEDULED)
      return rows.sort((a, b) => a.sendAt - b.sendAt).map(toRow)
    }
    const rows = await ctx.db
      .query('scheduledSends')
      .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('state', 'scheduled'))
      .take(MAX_SCHEDULED)
    return rows.map(toRow)
  },
})

/**
 * Schedules a message. Sealed exactly as for `messages.send`. `clientMessageId` is the send's
 * ID when it goes out, so scheduling the same ID twice does nothing.
 */
export const create = mutation({
  args: {
    chatId: v.id('chats'),
    clientMessageId: v.string(),
    forBridge: envelope,
    copy: envelope,
    sendAt: v.number(),
    replyTo: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.id('scheduledSends')),
  handler: async (ctx, { chatId, sendAt, ...input }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    if (await clientMessageIdUsed(ctx, member.userId, input.clientMessageId)) return null
    const now = Date.now()
    if (!Number.isFinite(sendAt) || sendAt <= now) throw new ConvexError('Pick a time in the future.')
    if (sendAt > now + MAX_AHEAD_MS) throw new ConvexError('Pick a time within a year.')
    await checkSend(ctx, chat, input)
    const pending = await ctx.db
      .query('scheduledSends')
      .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('state', 'scheduled'))
      .take(MAX_SCHEDULED)
    if (pending.length >= MAX_SCHEDULED) throw new ConvexError(`You can schedule at most ${MAX_SCHEDULED} messages.`)
    const id = await ctx.db.insert('scheduledSends', {
      userId: member.userId,
      chatId: chat._id,
      clientMessageId: input.clientMessageId,
      sendAt,
      state: 'scheduled',
      forBridge: input.forBridge,
      copy: input.copy,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: now,
    })
    await ctx.scheduler.runAt(sendAt, internal.scheduled.fire, { scheduledId: id })
    return id
  },
})

async function ownScheduled(ctx: MutationCtx, scheduledId: Doc<'scheduledSends'>['_id']) {
  const member = await requireMember(ctx)
  const row = await ctx.db.get(scheduledId)
  if (!row || row.userId !== member.userId) throw new ConvexError('That scheduled message doesn’t exist.')
  return row
}

/** Sends a scheduled message now. If its time already came, it is already on its way. */
async function sendScheduled(ctx: MutationCtx, row: Doc<'scheduledSends'>) {
  if (row.state !== 'scheduled' || !row.forBridge || !row.copy) return
  await ctx.db.patch(row._id, { state: 'sent', forBridge: undefined, copy: undefined })
  const chat = await ctx.db.get(row.chatId)
  // The chat is gone, so there's nowhere to send it. The person's copy goes with it.
  if (!chat || chat.deleted) return
  await queueSend(ctx, chat, {
    clientMessageId: row.clientMessageId,
    forBridge: row.forBridge,
    copy: row.copy,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
  })
}

export const cancel = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state !== 'scheduled') throw new ConvexError('That message has already gone out.')
    await ctx.db.patch(row._id, { state: 'cancelled', forBridge: undefined, copy: undefined })
    return null
  },
})

export const sendNow = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state !== 'scheduled') throw new ConvexError('That message has already gone out.')
    await sendScheduled(ctx, row)
    return null
  },
})

/** Runs at `sendAt`. A message cancelled or already sent meanwhile is left alone. */
export const fire = internalMutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ctx.db.get(scheduledId)
    if (row) await sendScheduled(ctx, row)
    return null
  },
})

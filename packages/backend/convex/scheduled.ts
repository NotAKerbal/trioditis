import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { checkSend, clientMessageIdUsed, queueSend } from './lib/send'
import { envelope } from './validators'

// Scheduled sends: a message to go out at `sendAt`, in its chat (and so on its network). When
// the time comes it becomes an ordinary send, and its 24-hour deadline starts then. Until then
// the sealed copies wait in `scheduledPayloads`, apart from the metadata so listing never reads
// them, and are deleted once the message goes out, is cancelled, or fails because its chat is
// gone. A failed one stays listed, so the person sees it didn't go, until they dismiss it.

const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000
const MAX_SCHEDULED = 500

const scheduledRow = v.object({
  _id: v.id('scheduledSends'),
  chatId: v.id('chats'),
  clientMessageId: v.string(),
  sendAt: v.number(),
  replyTo: v.union(v.null(), v.string()),
  /** `failed`: its time came and its chat was gone, so it was never sent. */
  state: v.union(v.literal('scheduled'), v.literal('failed')),
})

function toRow(row: Doc<'scheduledSends'>) {
  return {
    _id: row._id,
    chatId: row.chatId,
    clientMessageId: row.clientMessageId,
    sendAt: row.sendAt,
    replyTo: row.replyTo ?? null,
    state: row.state === 'failed' ? ('failed' as const) : ('scheduled' as const),
  }
}

async function payloadOf(ctx: QueryCtx, scheduledId: Doc<'scheduledSends'>['_id']) {
  return await ctx.db
    .query('scheduledPayloads')
    .withIndex('by_scheduled', (q) => q.eq('scheduledId', scheduledId))
    .unique()
}

async function deletePayload(ctx: MutationCtx, scheduledId: Doc<'scheduledSends'>['_id']) {
  const payload = await payloadOf(ctx, scheduledId)
  if (payload) await ctx.db.delete(payload._id)
}

/**
 * The person's scheduled messages, and those that failed and haven't been dismissed, soonest
 * first; in one chat if `chatId` is given. No content.
 */
export const list = query({
  args: { chatId: v.optional(v.id('chats')) },
  returns: v.array(scheduledRow),
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    if (chatId) await ownChat(ctx, member.userId, chatId)
    const rows = []
    for (const state of ['scheduled', 'failed'] as const) {
      if (chatId) {
        rows.push(
          ...(await ctx.db
            .query('scheduledSends')
            .withIndex('by_chat', (q) => q.eq('chatId', chatId).eq('state', state))
            .take(MAX_SCHEDULED)),
        )
      } else {
        rows.push(
          ...(await ctx.db
            .query('scheduledSends')
            .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('state', state))
            .take(MAX_SCHEDULED)),
        )
      }
    }
    return rows.sort((a, b) => a.sendAt - b.sendAt).map(toRow)
  },
})

/**
 * The person's own copies of up to 20 scheduled messages, to show what they say: sealed with
 * kind `message` and object ID `clientMessageId`.
 */
export const copies = query({
  args: { scheduledIds: v.array(v.id('scheduledSends')) },
  returns: v.array(v.object({ _id: v.id('scheduledSends'), copy: envelope })),
  handler: async (ctx, { scheduledIds }) => {
    const member = await requireMember(ctx)
    if (scheduledIds.length > 20) throw new ConvexError('Ask for at most 20 at once.')
    const out = []
    for (const scheduledId of scheduledIds) {
      const row = await ctx.db.get(scheduledId)
      if (!row || row.userId !== member.userId || row.state !== 'scheduled') continue
      const payload = await payloadOf(ctx, scheduledId)
      if (payload) out.push({ _id: scheduledId, copy: payload.copy })
    }
    return out
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
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: now,
    })
    await ctx.db.insert('scheduledPayloads', { scheduledId: id, forBridge: input.forBridge, copy: input.copy })
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
export async function sendScheduled(ctx: MutationCtx, row: Doc<'scheduledSends'>) {
  if (row.state !== 'scheduled') return
  const payload = await payloadOf(ctx, row._id)
  if (payload) await ctx.db.delete(payload._id)
  const chat = await ctx.db.get(row.chatId)
  // The chat is gone, so there's nowhere to send it: it fails, and stays listed as failed so
  // the person knows. The sealed copies go with it.
  if (!payload || !chat || chat.deleted) {
    await ctx.db.patch(row._id, { state: 'failed' })
    return
  }
  await ctx.db.patch(row._id, { state: 'sent' })
  await queueSend(ctx, chat, {
    clientMessageId: row.clientMessageId,
    forBridge: payload.forBridge,
    copy: payload.copy,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
  })
}

/** Cancels a scheduled message, or dismisses one that failed. */
export const cancel = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state !== 'scheduled' && row.state !== 'failed') throw new ConvexError('That message has already gone out.')
    await ctx.db.patch(row._id, { state: 'cancelled' })
    await deletePayload(ctx, row._id)
    return null
  },
})

export const sendNow = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state === 'failed') throw new ConvexError('That message couldn’t be sent: its chat is gone.')
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

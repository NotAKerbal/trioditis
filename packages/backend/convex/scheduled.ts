import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { alreadyUsed, checkSend, clientMessageIdUsed, queueSend, refuseRetryId } from './lib/send'
import { deliveryState, envelope } from './validators'

// Scheduled sends: a message to go out at `sendAt`, in its chat (and so on its network). When
// the time comes it becomes an ordinary send, and its 24-hour deadline starts then. Until then
// the sealed copies wait in `scheduledPayloads`, apart from the metadata so listing never reads
// them, and are deleted once the message goes out. A failed one stays listed, so the person
// sees it didn't go, until they dismiss it.
//
// Cancelling is the server's to decide: `cancel` says whether it was cancelled or had gone
// already, and a cancelled one keeps its sealed copy, listed in `cancelled`, until the person
// discards it (`forget`), however often its text is restored to a composer. So nothing has to
// be kept on the device, and nothing goes by itself, but for CANCELLED_KEEP_MS.

const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000
const MAX_SCHEDULED = 500
/** How long a cancelled message's copy waits to be restored or discarded. */
export const CANCELLED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const FORGET_BATCH = 200

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
            .withIndex('by_chat_kept', (q) => q.eq('chatId', chatId).eq('state', state))
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
      if (!row || row.userId !== member.userId) continue
      if (row.state !== 'scheduled' && !(row.state === 'cancelled' && !row.forgottenAt)) continue
      const payload = await payloadOf(ctx, scheduledId)
      if (payload) out.push({ _id: scheduledId, copy: payload.copy })
    }
    return out
  },
})

/**
 * Schedules a message. Sealed exactly as for `messages.send`. `clientMessageId` is the send's
 * ID when it goes out, so scheduling the same ID twice does nothing. Returns the scheduled ID,
 * or what the ID was used for already and where that stands (`alreadyUsed`, lib/send.ts).
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
  returns: v.union(v.id('scheduledSends'), alreadyUsed),
  handler: async (ctx, { chatId, sendAt, ...input }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    refuseRetryId(input.clientMessageId)
    const used = await clientMessageIdUsed(ctx, member.userId, input.clientMessageId)
    if (used) return used
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

/**
 * A cancelled message the person hasn't restored or discarded yet, in one chat or all: its
 * text is in `copies`. No content.
 */
export const cancelled = query({
  args: { chatId: v.optional(v.id('chats')) },
  returns: v.array(
    v.object({
      _id: v.id('scheduledSends'),
      chatId: v.id('chats'),
      clientMessageId: v.string(),
      replyTo: v.union(v.null(), v.string()),
      cancelledAt: v.number(),
    }),
  ),
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    if (chatId) await ownChat(ctx, member.userId, chatId)
    // Only those still holding their copies: forgotten ones never crowd them out.
    const rows = chatId
      ? await ctx.db
          .query('scheduledSends')
          .withIndex('by_chat_kept', (q) =>
            q.eq('chatId', chatId).eq('state', 'cancelled').eq('forgottenAt', undefined),
          )
          .take(MAX_SCHEDULED)
      : await ctx.db
          .query('scheduledSends')
          .withIndex('by_user_kept', (q) =>
            q.eq('userId', member.userId).eq('state', 'cancelled').eq('forgottenAt', undefined),
          )
          .take(MAX_SCHEDULED)
    return rows.map((row) => ({
      _id: row._id,
      chatId: row.chatId,
      clientMessageId: row.clientMessageId,
      replyTo: row.replyTo ?? null,
      cancelledAt: row.cancelledAt ?? row.createdAt,
    }))
  },
})

/**
 * Cancels a scheduled message, or dismisses one that failed. The answer is what happened:
 * `cancelled`, with its sealed copy (kind `message`, object ID `clientMessageId`) and the
 * message it replies to, kept until `forget`; or `sent` if its time, or Send now, came first,
 * with how that send stands now (its delivery state; null if not known).
 * Cancelling one already cancelled answers the same again, so a retry after a lost answer still
 * gets its text. A failed one is dismissed: its copies go at once, and the answer is `dismissed`.
 */
export const cancel = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.union(
    v.object({
      outcome: v.literal('cancelled'),
      /** This call is the one that cancelled it; false for a repeat, which changes nothing. */
      first: v.boolean(),
      clientMessageId: v.string(),
      copy: v.union(v.null(), envelope),
      replyTo: v.union(v.null(), v.string()),
    }),
    v.object({ outcome: v.literal('sent'), delivery: v.union(v.null(), deliveryState) }),
    v.object({ outcome: v.literal('dismissed') }),
  ),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state === 'sent') {
      const used = await clientMessageIdUsed(ctx, row.userId, row.clientMessageId)
      return { outcome: 'sent' as const, delivery: used?.already === 'send' ? used.delivery : null }
    }
    if (row.state === 'failed') {
      await ctx.db.patch(row._id, { state: 'cancelled', cancelledAt: Date.now(), forgottenAt: Date.now() })
      await deletePayload(ctx, row._id)
      return { outcome: 'dismissed' as const }
    }
    const first = row.state === 'scheduled'
    if (first) await ctx.db.patch(row._id, { state: 'cancelled', cancelledAt: Date.now() })
    const payload = row.forgottenAt ? null : await payloadOf(ctx, row._id)
    return {
      outcome: 'cancelled' as const,
      first,
      clientMessageId: row.clientMessageId,
      copy: payload?.copy ?? null,
      replyTo: row.replyTo ?? null,
    }
  },
})

/**
 * Lets a cancelled message's copies go, when the person discards it. Forgetting one already
 * forgotten does nothing.
 */
export const forget = mutation({
  args: { scheduledId: v.id('scheduledSends') },
  returns: v.null(),
  handler: async (ctx, { scheduledId }) => {
    const row = await ownScheduled(ctx, scheduledId)
    if (row.state !== 'cancelled') throw new ConvexError('Only a cancelled message can be discarded.')
    if (row.forgottenAt) return null
    await ctx.db.patch(row._id, { forgottenAt: Date.now() })
    await deletePayload(ctx, row._id)
    return null
  },
})

/** Forgets cancelled messages nobody restored or discarded within CANCELLED_KEEP_MS. */
export const forgetOldCancelled = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Only those still holding copies: each one forgotten leaves the range, so this never stalls.
    const rows = await ctx.db
      .query('scheduledSends')
      .withIndex('by_kept', (q) =>
        q
          .eq('state', 'cancelled')
          .eq('forgottenAt', undefined)
          .lt('cancelledAt', Date.now() - CANCELLED_KEEP_MS),
      )
      .take(FORGET_BATCH)
    for (const row of rows) {
      await ctx.db.patch(row._id, { forgottenAt: Date.now() })
      await deletePayload(ctx, row._id)
    }
    // More to do than one batch: carry on straight after.
    if (rows.length === FORGET_BATCH) await ctx.scheduler.runAfter(0, internal.scheduled.forgetOldCancelled, {})
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

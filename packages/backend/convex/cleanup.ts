import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'

// Clean-up that can be too big for the transaction that needs it, done in bounded batches.

const BATCH = 200

/** Deletes a deleted message's reactions, a batch at a time. */
export const reactionsOfMessage = internalMutation({
  args: { messageId: v.id('messages') },
  returns: v.null(),
  handler: async (ctx, { messageId }) => {
    const batch = await ctx.db
      .query('reactions')
      .withIndex('by_message', (q) => q.eq('messageId', messageId))
      .take(BATCH)
    for (const reaction of batch) await ctx.db.delete(reaction._id)
    if (batch.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.cleanup.reactionsOfMessage, { messageId })
      return null
    }
    // All gone: the marker that hid them while this ran can go too.
    const markers = await ctx.db
      .query('reactionCleanups')
      .withIndex('by_message', (q) => q.eq('messageId', messageId))
      .take(10)
    for (const marker of markers) await ctx.db.delete(marker._id)
    return null
  },
})

/** How many of a removed label's assignments one transaction removes. */
export const LABEL_BATCH = 1000

/** Takes a removed label off up to `LABEL_BATCH` chats, and schedules the rest if there are more. */
export async function removeAssignments(ctx: MutationCtx, labelId: Id<'labels'>) {
  const batch = await ctx.db
    .query('chatLabels')
    .withIndex('by_label', (q) => q.eq('labelId', labelId))
    .take(LABEL_BATCH)
  for (const row of batch) await ctx.db.delete(row._id)
  if (batch.length === LABEL_BATCH) await ctx.scheduler.runAfter(0, internal.cleanup.labelAssignments, { labelId })
}

/** Carries on taking a removed label off chats, a batch at a time. */
export const labelAssignments = internalMutation({
  args: { labelId: v.id('labels') },
  returns: v.null(),
  handler: async (ctx, { labelId }) => {
    await removeAssignments(ctx, labelId)
    return null
  },
})

import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'

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
    if (batch.length === BATCH) await ctx.scheduler.runAfter(0, internal.cleanup.reactionsOfMessage, { messageId })
    return null
  },
})

import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'

// One-off fixes for rows written by an older version. Each is safe to run again. Run them once
// after deploying the version that adds them (see docs/CONTRIBUTING.md, Schema changes).

const BATCH = 100

/**
 * Schedules `gateway.commandDeadline` for every command that still has a bridge-readable
 * payload and a deadline but was queued before commands scheduled their own, so its payload
 * is deleted on time too. A batch at a time, carrying on until it has been through them all:
 * `npx convex run migrations:scheduleCommandDeadlines`.
 */
export const scheduleCommandDeadlines = internalMutation({
  args: { cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('outboxPayloads').paginate({ numItems: BATCH, cursor: cursor ?? null })
    for (const payload of page.page) {
      const command = await ctx.db.get(payload.commandId)
      if (!command || command.expiresAt === undefined || command.deadlineScheduled) continue
      await ctx.db.patch(command._id, { deadlineScheduled: true })
      // A deadline already past runs now: the job checks the clock itself.
      await ctx.scheduler.runAt(Math.max(command.expiresAt, Date.now()), internal.gateway.commandDeadline, {
        commandId: command._id,
      })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.scheduleCommandDeadlines, { cursor: page.continueCursor })
    }
    return null
  },
})

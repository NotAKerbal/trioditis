import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, internalMutation } from './_generated/server'
import { refreshLast } from './lib/lastMessage'

// One-off fixes for rows written by an older version. Each is safe to run any number of times.
// `runAll` runs them all; `pnpm dev` and the self-hosted installer call it after every deploy,
// so a backend that keeps its data is always caught up (docs/CONTRIBUTING.md, Schema changes).

const BATCH = 100
/** The states a command can still be ended from; every other one is settled. */
const PENDING = ['queued', 'claimed', 'dispatched'] as const

/**
 * Schedules `gateway.commandDeadline` for every pending command with a deadline that was
 * queued before commands scheduled their own: with or without a bridge-readable payload, so
 * its payload is deleted on time and it ends (or is settled) on time too. It goes through
 * each pending state's commands by deadline, a batch at a time, carrying on until it has
 * been through them all: `npx convex run migrations:scheduleCommandDeadlines`.
 */
export const scheduleCommandDeadlines = internalMutation({
  args: { state: v.optional(v.number()), cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { state = 0, cursor }) => {
    const current = PENDING[state]
    if (!current) return null
    // From 0: a settled command has no `expiresAt`, which sorts before every number.
    const page = await ctx.db
      .query('outbox')
      .withIndex('by_expiry', (q) => q.eq('state', current).gte('expiresAt', 0))
      .paginate({ numItems: BATCH, cursor: cursor ?? null })
    for (const command of page.page) {
      if (command.expiresAt === undefined || command.deadlineScheduled) continue
      await ctx.db.patch(command._id, { deadlineScheduled: true })
      // A deadline already past runs now: the job checks the clock itself.
      await ctx.scheduler.runAt(Math.max(command.expiresAt, Date.now()), internal.gateway.commandDeadline, {
        commandId: command._id,
      })
    }
    const next = page.isDone ? { state: state + 1, cursor: null } : { state, cursor: page.continueCursor }
    if (PENDING[next.state]) await ctx.scheduler.runAfter(0, internal.migrations.scheduleCommandDeadlines, next)
    return null
  },
})

/**
 * How many chats one backfill batch goes through. Each may read its newest message, which can
 * be up to 768 KiB, so ten stay well inside a mutation's 16 MiB read limit.
 */
const LAST_BATCH = 10

/**
 * Gives every chat from before chats kept a pointer to their newest message (`chats.last`)
 * its pointer, a batch at a time, carrying on until it has been through them all. A chat
 * that has one already, `null` included, is left alone, so running it again changes nothing:
 * `npx convex run migrations:backfillChatLast`.
 */
export const backfillChatLast = internalMutation({
  args: { cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('chats').paginate({ numItems: LAST_BATCH, cursor: cursor ?? null })
    for (const chat of page.page) if (chat.last === undefined) await refreshLast(ctx, chat._id)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillChatLast, { cursor: page.continueCursor })
    }
    return null
  },
})

/**
 * Every migration, in order: the one entry point `pnpm dev` and the installer call. A new
 * migration must be added here as well as defined above, or it never runs on its own.
 */
export const runAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.migrations.scheduleCommandDeadlines, {})
    await ctx.runMutation(internal.migrations.backfillChatLast, {})
    return null
  },
})

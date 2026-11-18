import { v } from 'convex/values'
import { DEFAULT_PREFERENCES } from '@trioditis/core'
import { mutation, query } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'

// The person's own settings for the app. Missing settings take their defaults
// (`DEFAULT_PREFERENCES` in packages/core), so a person who never changed anything has no row.

const sidebarLayout = v.union(v.literal('focused'), v.literal('simple'))

export const get = query({
  args: {},
  returns: v.object({ sidebarLayout }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const row = await ctx.db
      .query('preferences')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .unique()
    return { sidebarLayout: row?.sidebarLayout ?? DEFAULT_PREFERENCES.sidebarLayout }
  },
})

/** Changes the settings given; leaves the rest as they are. */
export const set = mutation({
  args: { sidebarLayout: v.optional(sidebarLayout), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    const row = await ctx.db
      .query('preferences')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .unique()
    const sidebar = args.sidebarLayout ?? row?.sidebarLayout ?? DEFAULT_PREFERENCES.sidebarLayout
    if (row) await ctx.db.patch(row._id, { sidebarLayout: sidebar })
    else await ctx.db.insert('preferences', { userId: member.userId, sidebarLayout: sidebar })
    return null
  },
})

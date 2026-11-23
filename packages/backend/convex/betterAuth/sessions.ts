import { v } from 'convex/values'
import { query } from './_generated/server'

// The session check every signed-in call makes (lib/session.ts). It lives apart from
// adapter.ts because a module is loaded afresh for each call, and adapter.ts loads all of
// Better Auth and its plugins to build its options: about 200 ms of CPU per call, which made
// every query cost that much. This module loads nothing but the row it reads.

/** Whether the session `sessionId` is `userId`'s and hasn't expired. */
export const live = query({
  args: { sessionId: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sessionId, userId }) => {
    const id = ctx.db.normalizeId('session', sessionId)
    const session = id === null ? null : await ctx.db.get(id)
    return session !== null && session.userId === userId && session.expiresAt > Date.now()
  },
})

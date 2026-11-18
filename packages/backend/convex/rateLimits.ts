import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'

// Rate limits for Better Auth, kept in Convex. Better Auth's own store is memory, and each
// Convex HTTP action starts with none of it, so nothing it counted lasted to the next request.
//
// Each key has a token bucket: it holds up to `max` tokens, a request takes one, and it fills
// again at `max` per `window` seconds. So a client that stops waits only for the bucket to
// refill, with no lockout to sit out, and one that keeps going gets through at the refill rate.

/** Rounding left over from refilling by fractions of a token. */
const EPSILON = 1e-9

/** How many expired buckets one prune deletes. */
const PRUNE_BATCH = 500

/**
 * Takes a token from `key`'s bucket, in one transaction: concurrent requests for the same key
 * conflict and run again in turn, so no more than the bucket holds get through. A refused
 * request takes nothing and writes nothing.
 *
 * `retryAfter` is the whole seconds until the bucket has a token again.
 */
export const consume = internalMutation({
  args: { key: v.string(), max: v.number(), window: v.number() },
  returns: v.object({ allowed: v.boolean(), retryAfter: v.union(v.null(), v.number()) }),
  handler: async (ctx, { key, max, window }) => {
    const now = Date.now()
    const windowMs = window * 1000
    // Milliseconds for `tokens` to refill. Multiplying first keeps whole numbers exact, so a
    // client that waits exactly the Retry-After it was given finds its token.
    const refillMs = (tokens: number) => (tokens * windowMs) / max
    const row = await ctx.db
      .query('rateLimits')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    const tokens = row ? Math.min(max, row.tokens + (Math.max(0, now - row.updatedAt) * max) / windowMs) : max
    if (tokens < 1 - EPSILON) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(refillMs(1 - tokens) / 1000)) }
    }
    const left = Math.max(0, tokens - 1)
    const bucket = { tokens: left, updatedAt: now, fullAt: now + Math.ceil(refillMs(max - left)) }
    if (row) await ctx.db.patch(row._id, bucket)
    else await ctx.db.insert('rateLimits', { key, ...bucket })
    return { allowed: true, retryAfter: null }
  },
})

/** Deletes buckets that have refilled, which count the same as none. Run by a cron. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const refilled = await ctx.db
      .query('rateLimits')
      .withIndex('by_fullAt', (q) => q.lt('fullAt', Date.now()))
      .take(PRUNE_BATCH)
    for (const row of refilled) await ctx.db.delete(row._id)
    if (refilled.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.rateLimits.prune, {})
    return null
  },
})

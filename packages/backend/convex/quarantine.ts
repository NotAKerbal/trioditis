import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireAdmin } from './lib/access'
import { audit } from './lib/audit'

// Bridge host events the backend couldn't apply (gateway.ingest, gateway.quarantineInvalid),
// for admins to see and clear. A quarantined row holds only codes and IDs, never an event's
// content, and this returns less still: not whose event it was.

/** The most rows the list shows, newest first. */
const MAX_LISTED = 100
/** The count stops here and says there may be more. */
const MAX_COUNTED = 1000

const item = v.object({
  _id: v.id('quarantine'),
  hostId: v.string(),
  seq: v.number(),
  type: v.string(),
  reason: v.string(),
  at: v.number(),
})

/** The newest quarantined events, and how many there are (up to 1,000, then "at least"). */
export const list = query({
  args: {},
  returns: v.object({ items: v.array(item), count: v.number(), more: v.boolean() }),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const rows = await ctx.db
      .query('quarantine')
      .withIndex('by_at')
      .order('desc')
      .take(MAX_COUNTED + 1)
    return {
      items: rows.slice(0, MAX_LISTED).map(({ _id, hostId, seq, type, reason, at }) => ({
        _id,
        hostId,
        seq,
        type,
        reason,
        at,
      })),
      count: Math.min(rows.length, MAX_COUNTED),
      more: rows.length > MAX_COUNTED,
    }
  },
})

/**
 * Clears quarantined events the admin has looked at. They were already acknowledged to their
 * bridge host, so nothing is replayed: this only removes the record.
 */
export const dismiss = mutation({
  args: { ids: v.array(v.id('quarantine')), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    if (args.ids.length > MAX_LISTED) throw new ConvexError('Dismiss at most 100 at a time.')
    let removed = 0
    for (const id of args.ids) {
      if (!(await ctx.db.get(id))) continue
      await ctx.db.delete(id)
      removed++
    }
    if (removed) await audit(ctx, { kind: 'user', id: admin.userId }, 'quarantine.dismiss', String(removed))
    return null
  },
})

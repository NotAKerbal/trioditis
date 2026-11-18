import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { removeAssignments } from './cleanup'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'
import { isEnvelope } from './lib/envelope'
import { envelope } from './validators'

// The person's own labels. A label's name and colour are sealed to the person: kind `label`,
// object ID `labelKey`, which the client picks before sealing (16 to 64 letters, digits, `-`
// and `_`). Assign them to chats with `chats.setLabels`.

const LABEL_KEY = /^[A-Za-z0-9_-]{16,64}$/
const MAX_LABELS = 100
const MAX_LABEL_BYTES = 4 * 1024

const labelRow = v.object({ _id: v.id('labels'), labelKey: v.string(), sealed: envelope, createdAt: v.number() })

export const list = query({
  args: {},
  returns: v.array(labelRow),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const rows = await ctx.db
      .query('labels')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(MAX_LABELS)
    return rows.map(({ _id, labelKey, sealed, createdAt }) => ({ _id, labelKey, sealed, createdAt }))
  },
})

export const create = mutation({
  args: { labelKey: v.string(), sealed: envelope, sessionId: v.optional(v.string()) },
  returns: v.id('labels'),
  handler: async (ctx, { labelKey, sealed, sessionId }) => {
    // A label sealed on a page another tab's sign-in has switched would be stored for the
    // other account, which can't open it.
    await requireSessionIfGiven(ctx, sessionId)
    const member = await requireMember(ctx)
    if (!LABEL_KEY.test(labelKey)) throw new ConvexError('That label ID isn’t valid.')
    if (!isEnvelope(sealed, MAX_LABEL_BYTES)) throw new ConvexError('That label isn’t sealed, or is too long.')
    const existing = await ctx.db
      .query('labels')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(MAX_LABELS + 1)
    const same = existing.find((label) => label.labelKey === labelKey)
    if (same) return same._id
    if (existing.length >= MAX_LABELS) throw new ConvexError(`You can have at most ${MAX_LABELS} labels.`)
    return await ctx.db.insert('labels', { userId: member.userId, labelKey, sealed, createdAt: Date.now() })
  },
})

/** Renames or recolours a label: new content, sealed with the same `labelKey`. */
export const update = mutation({
  args: { labelId: v.id('labels'), sealed: envelope },
  returns: v.null(),
  handler: async (ctx, { labelId, sealed }) => {
    const member = await requireMember(ctx)
    const label = await ctx.db.get(labelId)
    if (!label || label.userId !== member.userId) throw new ConvexError('That label doesn’t exist.')
    if (!isEnvelope(sealed, MAX_LABEL_BYTES)) throw new ConvexError('That label isn’t sealed, or is too long.')
    await ctx.db.patch(labelId, { sealed })
    return null
  },
})

/**
 * Deletes a label and takes it off every chat. A label can be on any number of chats, so it
 * comes off the first thousand here and the rest in batches straight after; until then a chat
 * may still list the label's ID, which isn't in `labels.list` any more.
 */
export const remove = mutation({
  args: { labelId: v.id('labels') },
  returns: v.null(),
  handler: async (ctx, { labelId }) => {
    const member = await requireMember(ctx)
    const label = await ctx.db.get(labelId)
    if (!label || label.userId !== member.userId) throw new ConvexError('That label doesn’t exist.')
    await ctx.db.delete(labelId)
    await removeAssignments(ctx, labelId)
    return null
  },
})

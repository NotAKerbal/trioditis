import type { MutationCtx, QueryCtx } from '../_generated/server'

// People an admin removed (members.removeMember) whose network accounts must still be logged out.
// Their `removedMembers` record is `active` while any of their accounts isn't logged out, and
// Settings → Members lists the active ones, however old.

/** More than anyone has: a removed person's accounts are all read in one go. */
const ACCOUNTS = 200

export async function isMember(ctx: QueryCtx, userId: string) {
  const member = await ctx.db
    .query('members')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
  return member !== null
}

/** A removed person's network accounts not yet confirmed logged out. */
export async function leftSignedIn(ctx: QueryCtx, userId: string) {
  const accounts = await ctx.db
    .query('networkAccounts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(ACCOUNTS)
  return accounts.filter((account) => account.state !== 'LOGGED_OUT')
}

/**
 * Makes sure a removed person has a cleanup record, active while any of their accounts is left:
 * on removal, and again for an account of theirs that turns up after it (a login that finished
 * meanwhile, or a logged-out account reconnecting), so its logout shows and can be tried again.
 */
export async function noteCleanup(
  ctx: MutationCtx,
  userId: string,
  fields: { email?: string; removedBy: string } = { removedBy: 'bridge' },
) {
  const active = (await leftSignedIn(ctx, userId)).length > 0
  const existing = await ctx.db
    .query('removedMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first()
  if (existing) {
    if (existing.active !== active) await ctx.db.patch(existing._id, { active })
    return
  }
  await ctx.db.insert('removedMembers', { userId, ...fields, removedAt: Date.now(), active })
}

/** Marks a removed person's cleanup done once none of their accounts is left signed in. */
export async function settleCleanup(ctx: MutationCtx, userId: string) {
  const record = await ctx.db
    .query('removedMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first()
  if (!record?.active) return
  if ((await leftSignedIn(ctx, userId)).length === 0) await ctx.db.patch(record._id, { active: false })
}

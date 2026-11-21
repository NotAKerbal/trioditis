import type { MutationCtx, QueryCtx } from '../_generated/server'

// People an admin removed (members.removeMember) whose network accounts must still be logged out.
// Their `removedMembers` record is what Settings → Members lists until every account is.

export async function isMember(ctx: QueryCtx, userId: string) {
  const member = await ctx.db
    .query('members')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
  return member !== null
}

/**
 * Makes sure a removed person has a cleanup record, for an account of theirs that turns up after
 * the removal (a login that finished meanwhile), so its logout shows and can be tried again.
 */
export async function noteCleanup(
  ctx: MutationCtx,
  userId: string,
  fields: { email?: string; removedBy: string } = { removedBy: 'bridge' },
) {
  const existing = await ctx.db
    .query('removedMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .first()
  if (existing) return
  await ctx.db.insert('removedMembers', { userId, ...fields, removedAt: Date.now() })
}

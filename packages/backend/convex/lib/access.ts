import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { requireUserId } from '../auth'

/** The signed-in person's membership on this server, or an error. */
export async function requireMember(ctx: QueryCtx): Promise<Doc<'members'>> {
  const userId = await requireUserId(ctx)
  const member = await ctx.db
    .query('members')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
  if (!member) throw new ConvexError('Your account isn’t a member of this server.')
  return member
}

export async function requireAdmin(ctx: QueryCtx): Promise<Doc<'members'>> {
  const member = await requireMember(ctx)
  if (member.role !== 'admin') throw new ConvexError('Only an admin can do that.')
  return member
}

/** A chat, if it belongs to `userId`. Every chat lookup by ID goes through here. */
export async function ownChat(ctx: QueryCtx, userId: string, chatId: Doc<'chats'>['_id']): Promise<Doc<'chats'>> {
  const chat = await ctx.db.get(chatId)
  if (!chat || chat.userId !== userId) throw new ConvexError('That chat doesn’t exist.')
  return chat
}

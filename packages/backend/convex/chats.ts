import { v } from 'convex/values'
import { query } from './_generated/server'
import { ownChat, requireMember } from './lib/access'

// The inbox. Names, topics and avatars are sealed; the client opens `sealedMeta`.

export const list = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    const member = await requireMember(ctx)
    const chats = await ctx.db
      .query('chats')
      .withIndex('by_user_lastMessage', (q) => q.eq('userId', member.userId))
      .order('desc')
      .take(200)
    return chats.filter((chat) => !chat.deleted && (includeArchived || !chat.archived))
  },
})

export const get = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    return await ownChat(ctx, member.userId, chatId)
  },
})

import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import { query } from './_generated/server'
import { ownChat, requireMember } from './lib/access'

// The inbox. Names, topics and avatars are sealed; the client opens `sealedMeta`.

/**
 * The person's chats, most recent first, a page at a time. Deleted (and, unless asked,
 * archived) chats are left out of each page, so a page can hold fewer than asked for; keep
 * loading with the cursor until `isDone`.
 */
export const list = query({
  args: { includeArchived: v.optional(v.boolean()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { includeArchived, paginationOpts }) => {
    const member = await requireMember(ctx)
    const result = await ctx.db
      .query('chats')
      .withIndex('by_user_lastMessage', (q) => q.eq('userId', member.userId))
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(Math.max(1, paginationOpts.numItems), 200),
        maximumBytesRead: Math.min(paginationOpts.maximumBytesRead ?? 8 * 1024 * 1024, 8 * 1024 * 1024),
      })
    return { ...result, page: result.page.filter((chat) => !chat.deleted && (includeArchived || !chat.archived)) }
  },
})

export const get = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    return await ownChat(ctx, member.userId, chatId)
  },
})

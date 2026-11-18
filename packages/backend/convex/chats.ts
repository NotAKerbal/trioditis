import { ConvexError, v } from 'convex/values'
import type { ChatRow } from '@trioditis/core'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { queueCommand } from './lib/outbox'
import { chatKind, envelope, network } from './validators'

// The inbox, and what the person does to a chat. Names, topics and avatars are sealed; the
// client opens `sealedMeta`. See docs/architecture/client-api.md, Chats.

/** The longest a chat can be snoozed or muted for, short of "forever" (mute without `until`). */
const MAX_UNTIL_MS = 400 * 24 * 60 * 60 * 1000

const chatRow = v.object({
  _id: v.id('chats'),
  network,
  networkAccountId: v.union(v.null(), v.id('networkAccounts')),
  kind: chatKind,
  sealedMeta: v.union(v.null(), envelope),
  portalId: v.string(),
  unreadCount: v.number(),
  mentionCount: v.number(),
  markedUnread: v.boolean(),
  pinned: v.boolean(),
  archived: v.boolean(),
  mutedUntil: v.union(v.null(), v.number()),
  snoozedUntil: v.union(v.null(), v.number()),
  woke: v.boolean(),
  isRequest: v.boolean(),
  blocked: v.boolean(),
  labelIds: v.array(v.id('labels')),
  lastMessageAt: v.number(),
})

const view = v.union(
  v.literal('inbox'),
  v.literal('archived'),
  v.literal('snoozed'),
  v.literal('requests'),
  v.literal('blocked'),
)

function isSnoozed(chat: Doc<'chats'>) {
  return chat.snoozedUntil !== undefined && !chat.woke
}

/** Which view a chat belongs in. Every chat is in exactly one. */
function viewOf(
  chat: Doc<'chats'>,
): ChatRow extends never ? never : 'inbox' | 'archived' | 'snoozed' | 'requests' | 'blocked' {
  if (chat.blocked) return 'blocked'
  if (chat.isRequest) return 'requests'
  if (isSnoozed(chat)) return 'snoozed'
  if (chat.archived) return 'archived'
  return 'inbox'
}

async function rowFor(ctx: QueryCtx, chat: Doc<'chats'>, accounts: Map<string, Id<'networkAccounts'> | null>) {
  const accountKey = `${chat.network}:${chat.loginId}`
  if (!accounts.has(accountKey)) {
    const account = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', chat.network).eq('loginId', chat.loginId))
      .unique()
    accounts.set(accountKey, account && account.userId === chat.userId ? account._id : null)
  }
  const labels = await ctx.db
    .query('chatLabels')
    .withIndex('by_chat', (q) => q.eq('chatId', chat._id))
    .take(50)
  return {
    _id: chat._id,
    network: chat.network,
    networkAccountId: accounts.get(accountKey) ?? null,
    kind: chat.kind,
    sealedMeta: chat.sealedMeta ?? null,
    portalId: chat.portalId,
    unreadCount: chat.unreadCount,
    mentionCount: chat.mentionCount ?? 0,
    markedUnread: chat.markedUnread ?? false,
    pinned: chat.pinned,
    archived: chat.archived,
    mutedUntil: chat.mutedUntil ?? null,
    snoozedUntil: chat.snoozedUntil ?? null,
    woke: chat.woke ?? false,
    isRequest: chat.isRequest ?? false,
    blocked: chat.blocked ?? false,
    labelIds: labels.map((label) => label.labelId),
    lastMessageAt: chat.lastMessageAt,
  }
}

/**
 * The chat list for one view, pinned chats first, then most recent. Optionally only one
 * network, or only chats with one label. At most 200 rows.
 */
export const list = query({
  args: {
    view: v.optional(view),
    network: v.optional(network),
    labelId: v.optional(v.id('labels')),
  },
  returns: v.array(chatRow),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    const wanted = args.view ?? 'inbox'
    let labelled: Set<string> | null = null
    if (args.labelId) {
      const label = await ctx.db.get(args.labelId)
      if (!label || label.userId !== member.userId) throw new ConvexError('That label doesn’t exist.')
      const labelId = args.labelId
      const rows = await ctx.db
        .query('chatLabels')
        .withIndex('by_label', (q) => q.eq('labelId', labelId))
        .take(1000)
      labelled = new Set(rows.map((row) => row.chatId))
    }
    const chats = await ctx.db
      .query('chats')
      .withIndex('by_user_lastMessage', (q) => q.eq('userId', member.userId))
      .order('desc')
      .take(1000)
    const matching = chats
      .filter((chat) => !chat.deleted && viewOf(chat) === wanted)
      .filter((chat) => !args.network || chat.network === args.network)
      .filter((chat) => !labelled || labelled.has(chat._id))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt)
      .slice(0, 200)
    const accounts = new Map<string, Id<'networkAccounts'> | null>()
    return await Promise.all(matching.map((chat) => rowFor(ctx, chat, accounts)))
  },
})

export const get = query({
  args: { chatId: v.id('chats') },
  returns: chatRow,
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    return await rowFor(ctx, await ownChat(ctx, member.userId, chatId), new Map())
  },
})

/** How many chats in each view have something unread, for the sidebar's counts. */
export const counts = query({
  args: {},
  returns: v.object({ inbox: v.number(), requests: v.number(), woke: v.number() }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const chats = await ctx.db
      .query('chats')
      .withIndex('by_user_lastMessage', (q) => q.eq('userId', member.userId))
      .order('desc')
      .take(1000)
    let inbox = 0
    let requests = 0
    let woke = 0
    for (const chat of chats) {
      if (chat.deleted) continue
      const unread = chat.unreadCount > 0 || chat.markedUnread === true
      const where = viewOf(chat)
      if (where === 'inbox' && unread && !(chat.mutedUntil && chat.mutedUntil > Date.now())) inbox++
      if (where === 'requests') requests++
      if (where === 'inbox' && chat.woke) woke++
    }
    return { inbox, requests, woke }
  },
})

async function ownForChange(ctx: MutationCtx, chatId: Id<'chats'>) {
  const member = await requireMember(ctx)
  return await ownChat(ctx, member.userId, chatId)
}

function checkUntil(until: number) {
  const now = Date.now()
  if (!Number.isFinite(until) || until <= now) throw new ConvexError('Pick a time in the future.')
  if (until > now + MAX_UNTIL_MS) throw new ConvexError('Pick a time within a year.')
}

/**
 * Marks a chat read: clears unread, mentions and "marked unread", ends a woken snooze, and
 * tells the network the person read up to the latest message (if it reached the network).
 */
export const markRead = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, {
      unreadCount: 0,
      mentionCount: 0,
      markedUnread: false,
      ...(chat.woke ? { woke: false, snoozedUntil: undefined } : {}),
    })
    const recent = await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chat._id))
      .order('desc')
      .take(20)
    const latest = recent.find((message) => !message.eventId.startsWith('pending:'))
    if (!latest) return null
    await queueCommand(ctx, {
      userId: chat.userId,
      network: chat.network,
      loginId: chat.loginId,
      chatId: chat._id,
      payload: { type: 'markRead', portalId: chat.portalId, upToEventId: latest.eventId },
      state: 'queued',
      attempts: 0,
      createdAt: Date.now(),
    })
    return null
  },
})

/** Marks a chat unread. Trioditis-side only: the network still sees it as read. */
export const markUnread = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { markedUnread: true })
    return null
  },
})

export const setArchived = mutation({
  args: { chatId: v.id('chats'), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, archived }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { archived })
    return null
  },
})

export const setPinned = mutation({
  args: { chatId: v.id('chats'), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, pinned }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { pinned })
    return null
  },
})

/** Mutes notifications until `until`, forever without it, or unmutes with `muted: false`. */
export const setMuted = mutation({
  args: { chatId: v.id('chats'), muted: v.boolean(), until: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { chatId, muted, until }) => {
    const chat = await ownForChange(ctx, chatId)
    if (!muted) {
      await ctx.db.patch(chat._id, { mutedUntil: undefined })
      return null
    }
    if (until !== undefined) checkUntil(until)
    // "Forever" is stored as the largest time a number holds exactly.
    await ctx.db.patch(chat._id, { mutedUntil: until ?? Number.MAX_SAFE_INTEGER })
    return null
  },
})

/**
 * Hides a chat from the inbox until `until`. It comes back (`woke: true`) then, or sooner if
 * someone messages, and stays marked as back until the person reads it or wakes it.
 */
export const snooze = mutation({
  args: { chatId: v.id('chats'), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { chatId, until }) => {
    const chat = await ownForChange(ctx, chatId)
    checkUntil(until)
    await ctx.db.patch(chat._id, { snoozedUntil: until, woke: false })
    await ctx.scheduler.runAt(until, internal.chats.snoozeEnded, { chatId: chat._id, until })
    return null
  },
})

/** Ends a snooze now, whether or not it has woken. */
export const wake = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { snoozedUntil: undefined, woke: false })
    return null
  },
})

/** Runs at a snooze's end. A later snooze of the same chat has its own; this one does nothing then. */
export const snoozeEnded = internalMutation({
  args: { chatId: v.id('chats'), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { chatId, until }) => {
    const chat = await ctx.db.get(chatId)
    if (chat && chat.snoozedUntil === until && !chat.woke) await ctx.db.patch(chatId, { woke: true })
    return null
  },
})

/** Accepts a message request: the chat moves to the inbox. Trioditis-side only for now. */
export const acceptRequest = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { isRequest: false })
    return null
  },
})

/**
 * Blocks or unblocks a chat. Trioditis-side only for now: it's hidden here and doesn't notify
 * or count, but the network isn't told and messages still arrive.
 */
export const setBlocked = mutation({
  args: { chatId: v.id('chats'), blocked: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, blocked }) => {
    const chat = await ownForChange(ctx, chatId)
    await ctx.db.patch(chat._id, { blocked })
    return null
  },
})

/** Sets a chat's labels to exactly `labelIds` (the person's own labels, at most 20). */
export const setLabels = mutation({
  args: { chatId: v.id('chats'), labelIds: v.array(v.id('labels')) },
  returns: v.null(),
  handler: async (ctx, { chatId, labelIds }) => {
    const chat = await ownForChange(ctx, chatId)
    if (labelIds.length > 20) throw new ConvexError('A chat can have at most 20 labels.')
    const wanted = new Set<Id<'labels'>>()
    for (const labelId of labelIds) {
      const label = await ctx.db.get(labelId)
      if (!label || label.userId !== chat.userId) throw new ConvexError('That label doesn’t exist.')
      wanted.add(labelId)
    }
    const current = await ctx.db
      .query('chatLabels')
      .withIndex('by_chat', (q) => q.eq('chatId', chat._id))
      .collect()
    for (const row of current) {
      if (wanted.has(row.labelId)) wanted.delete(row.labelId)
      else await ctx.db.delete(row._id)
    }
    for (const labelId of wanted) await ctx.db.insert('chatLabels', { userId: chat.userId, chatId: chat._id, labelId })
    return null
  },
})

import { paginationOptsValidator, paginationResultValidator } from 'convex/server'
import { ConvexError, v, type Infer } from 'convex/values'
import type { ChatRow } from '@trioditis/core'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
import { patchChat } from './lib/chatView'
import { queueCommand } from './lib/outbox'
import { chatKind, chatView, envelope, network } from './validators'

// The inbox, and what the person does to a chat. Names, topics and avatars are sealed; the
// client opens `sealedMeta`. Each chat's list (`view`) is kept by lib/chatView.ts, so every
// list here is an index range. See docs/architecture/client-api.md, Chats.

/** The longest a chat can be snoozed or muted for, short of "until I unmute". */
const MAX_UNTIL_MS = 400 * 24 * 60 * 60 * 1000
/** Pinned chats come first, on the first page; at most this many are shown. */
const MAX_PINS = 50
/** The most chats one page holds, and the most it reads, well under a query's limits. */
const MAX_PAGE_ITEMS = 50
const MAX_PAGE_BYTES = 8 * 1024 * 1024
/** Badge counts stop here and say there may be more. */
const COUNT_CAP = 99
/** How far mark-read looks back for the latest message that reached the network. */
const READ_SCAN = 50

// Matches `ChatRow` in @trioditis/core; the check at the end of this file keeps them in step.
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
    .take(20)
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

function pageOptions(opts: Infer<typeof paginationOptsValidator>) {
  return {
    ...opts,
    numItems: Math.min(Math.max(1, opts.numItems), MAX_PAGE_ITEMS),
    maximumBytesRead: Math.min(opts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
  }
}

/**
 * One list of chats, a page at a time: on the first page the pinned chats (at most 50), then
 * the rest, most recent first. With `network`, only that network's chats. With `labelId`, the
 * chats with that label, in the order they were labelled, pinned or not.
 */
export const list = query({
  args: {
    view: v.optional(chatView),
    network: v.optional(network),
    labelId: v.optional(v.id('labels')),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(chatRow),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    const userId = member.userId
    const view = args.view ?? 'inbox'
    const opts = pageOptions(args.paginationOpts)
    const accounts = new Map<string, Id<'networkAccounts'> | null>()

    if (args.labelId) {
      const label = await ctx.db.get(args.labelId)
      if (!label || label.userId !== userId) throw new ConvexError('That label doesn’t exist.')
      const labelId = args.labelId
      const result = await ctx.db
        .query('chatLabels')
        .withIndex('by_label', (q) => q.eq('labelId', labelId))
        .paginate(opts)
      const chats = []
      for (const row of result.page) {
        const chat = await ctx.db.get(row.chatId)
        if (chat && chat.userId === userId && chat.view === view && (!args.network || chat.network === args.network)) {
          chats.push(await rowFor(ctx, chat, accounts))
        }
      }
      return { ...result, page: chats }
    }

    const network = args.network
    const pinned =
      args.paginationOpts.cursor === null
        ? network
          ? (
              await ctx.db
                .query('chats')
                .withIndex('by_user_view_network_last', (q) => q.eq('userId', userId).eq('view', view).eq('network', network))
                .order('desc')
                .filter((q) => q.eq(q.field('pinned'), true))
                .take(MAX_PINS)
            )
          : await ctx.db
              .query('chats')
              .withIndex('by_user_view_pinned_last', (q) => q.eq('userId', userId).eq('view', view).eq('pinned', true))
              .order('desc')
              .take(MAX_PINS)
        : []
    const rest = network
      ? await ctx.db
          .query('chats')
          .withIndex('by_user_view_network_last', (q) => q.eq('userId', userId).eq('view', view).eq('network', network))
          .order('desc')
          .filter((q) => q.eq(q.field('pinned'), false))
          .paginate(opts)
      : await ctx.db
          .query('chats')
          .withIndex('by_user_view_pinned_last', (q) => q.eq('userId', userId).eq('view', view).eq('pinned', false))
          .order('desc')
          .paginate(opts)
    const page = []
    for (const chat of [...pinned, ...rest.page]) page.push(await rowFor(ctx, chat, accounts))
    return { ...rest, page }
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

const count = v.object({ count: v.number(), more: v.boolean() })

/**
 * The sidebar's badges: unread unmuted inbox chats, message requests, and woken snoozes.
 * Each reads a bounded range and stops at 99, with `more` saying there may be others.
 */
export const counts = query({
  args: {},
  returns: v.object({ inbox: count, requests: count, woke: count }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const userId = member.userId
    const now = Date.now()
    const scan = 4 * COUNT_CAP
    const inbox = await ctx.db
      .query('chats')
      .withIndex('by_user_view_pinned_last', (q) => q.eq('userId', userId).eq('view', 'inbox'))
      .order('desc')
      .take(scan)
    const requests = await ctx.db
      .query('chats')
      .withIndex('by_user_view_pinned_last', (q) => q.eq('userId', userId).eq('view', 'requests'))
      .take(COUNT_CAP + 1)
    const capped = (n: number, partial: boolean) => ({ count: Math.min(n, COUNT_CAP), more: n > COUNT_CAP || partial })
    const scannedAll = inbox.length < scan
    const unread = inbox.filter(
      (chat) => (chat.unreadCount > 0 || chat.markedUnread === true) && !(chat.mutedUntil !== undefined && chat.mutedUntil > now),
    ).length
    return {
      inbox: capped(unread, !scannedAll),
      requests: capped(requests.length, false),
      woke: capped(inbox.filter((chat) => chat.woke).length, !scannedAll),
    }
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
 * Marks a chat read: clears unread, mentions and "marked unread", and ends a woken snooze.
 * If one of the 50 newest messages reached the network and isn't deleted, the network is told
 * the person read up to it; otherwise only Trioditis changes.
 */
export const markRead = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    const chat = await ownForChange(ctx, chatId)
    await patchChat(ctx, chat, {
      unreadCount: 0,
      mentionCount: 0,
      markedUnread: false,
      ...(chat.woke ? { woke: false, snoozedUntil: undefined } : {}),
    })
    const recent = await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chat._id))
      .order('desc')
      .take(READ_SCAN)
    const latest = recent.find((message) => !message.eventId.startsWith('pending:') && message.redactedAt === undefined)
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
    await patchChat(ctx, await ownForChange(ctx, chatId), { markedUnread: true })
    return null
  },
})

export const setArchived = mutation({
  args: { chatId: v.id('chats'), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, archived }) => {
    await patchChat(ctx, await ownForChange(ctx, chatId), { archived })
    return null
  },
})

export const setPinned = mutation({
  args: { chatId: v.id('chats'), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, pinned }) => {
    await patchChat(ctx, await ownForChange(ctx, chatId), { pinned })
    return null
  },
})

/** Mutes notifications until `until`, until unmuted without it, or unmutes with `muted: false`. */
export const setMuted = mutation({
  args: { chatId: v.id('chats'), muted: v.boolean(), until: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { chatId, muted, until }) => {
    const chat = await ownForChange(ctx, chatId)
    if (!muted) {
      await patchChat(ctx, chat, { mutedUntil: undefined })
      return null
    }
    if (until !== undefined) checkUntil(until)
    // "Until I unmute" is stored as the largest time a number holds exactly.
    await patchChat(ctx, chat, { mutedUntil: until ?? Number.MAX_SAFE_INTEGER })
    return null
  },
})

/**
 * Hides a chat until `until`. It comes back (`woke: true`, and unarchived) then, or sooner if
 * someone messages, and stays marked as back until the person reads it or wakes it.
 */
export const snooze = mutation({
  args: { chatId: v.id('chats'), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { chatId, until }) => {
    const chat = await ownForChange(ctx, chatId)
    checkUntil(until)
    await patchChat(ctx, chat, { snoozedUntil: until, woke: false })
    await ctx.scheduler.runAt(until, internal.chats.snoozeEnded, { chatId: chat._id, until })
    return null
  },
})

/** Ends a snooze now, whether or not it has woken. */
export const wake = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    await patchChat(ctx, await ownForChange(ctx, chatId), { snoozedUntil: undefined, woke: false })
    return null
  },
})

/** Runs at a snooze's end. A later snooze of the same chat has its own; this one does nothing then. */
export const snoozeEnded = internalMutation({
  args: { chatId: v.id('chats'), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { chatId, until }) => {
    const chat = await ctx.db.get(chatId)
    if (chat && chat.snoozedUntil === until && !chat.woke) await patchChat(ctx, chat, { woke: true })
    return null
  },
})

/** Accepts a message request: the chat moves to the inbox. Trioditis-side for now. */
export const acceptRequest = mutation({
  args: { chatId: v.id('chats') },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    await patchChat(ctx, await ownForChange(ctx, chatId), { isRequest: false })
    return null
  },
})

/**
 * Blocks or unblocks a chat. Trioditis-side for now: it's hidden here and doesn't notify or
 * count, but the network isn't told and messages still arrive.
 */
export const setBlocked = mutation({
  args: { chatId: v.id('chats'), blocked: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { chatId, blocked }) => {
    await patchChat(ctx, await ownForChange(ctx, chatId), { blocked })
    return null
  },
})

/** Sets a chat's labels to exactly `labelIds` (the person's own, at most 20). */
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
      .take(20)
    for (const row of current) {
      if (wanted.has(row.labelId)) wanted.delete(row.labelId)
      else await ctx.db.delete(row._id)
    }
    for (const labelId of wanted) await ctx.db.insert('chatLabels', { userId: chat.userId, chatId: chat._id, labelId })
    return null
  },
})

// `chats.list` returns exactly what @trioditis/core calls a `ChatRow`.
type Returned = Infer<typeof chatRow>
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _rowMatchesCore: SameShape<keyof Returned, keyof ChatRow> = true

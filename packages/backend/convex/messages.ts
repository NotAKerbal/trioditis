import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v, type Infer } from 'convex/values'
import { NETWORK_INFO, type Arrival, type ArrivalFeed } from '@trioditis/core'
import type { Id } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { chatRow, clientLastMessage, lastMessage, rowFor } from './chats'
import { ownChat, requireMember } from './lib/access'
import { byteSize, MAX_MESSAGE_ROW_BYTES } from './lib/bounded'
import { markOwnReadRange as markRange } from './lib/ingest'
import { forgetMessage, lastOf } from './lib/lastMessage'
import { retired } from './lib/networks'
import { queueCommand } from './lib/outbox'
import { retryPlan, retryState } from './lib/retry'
import { alreadyUsed, checkSend, clientMessageIdUsed, queueSend, refuseRetryId } from './lib/send'
import { envelope } from './validators'

/** The most messages one page holds. */
const MAX_PAGE_ITEMS = 100
/** The most one page reads, well under a query's 16 MiB limit. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024

/** A chat's messages, newest first, a page at a time. Content is sealed. */
export const list = query({
  args: { chatId: v.id('chats'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { chatId, paginationOpts }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    // A page holds what the client asks for, up to a size the server bounds: messages can be
    // large (a capped original plus its latest edit), so a page ends early rather than
    // failing. The client keeps loading with the returned cursor.
    return await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(Math.max(1, paginationOpts.numItems), MAX_PAGE_ITEMS),
        maximumBytesRead: Math.min(paginationOpts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
      })
  },
})

/** The most arrivals `arrivals` returns: more between two answers notify for the newest. */
const ARRIVALS = 10
/**
 * The most live messages it looks through to find them (the person's own sends and other
 * views' messages are skipped), and the most bytes of them, well under a query's 16 MiB.
 */
const ARRIVALS_SCAN = 50
const ARRIVALS_BYTES = 8 * 1024 * 1024

const arrival = v.object({ arrivedAt: v.number(), message: lastMessage, chat: chatRow })
const arrivalFeed = v.object({ latest: v.union(v.null(), v.number()), arrivals: v.array(arrival) })

/**
 * The newest messages from other people, by when they arrived, for notifications: never
 * imported history, the person's own, deleted ones, or chats outside the inbox. `latest` is
 * when the newest live message of any kind arrived, a cursor that doesn't move when a chat
 * changes view, so the client notifies only for what arrived after its first answer. See
 * client-api.md, Arrivals.
 */
export const arrivals = query({
  args: {},
  returns: arrivalFeed,
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const accounts = new Map<string, Id<'networkAccounts'> | null>()
    const out: Infer<typeof arrival>[] = []
    let latest: number | null = null
    let before: number | undefined
    let seen = 0
    let bytes = 0
    // A few rows at a time, only as many as can't pass the byte budget however large they are.
    scan: while (seen < ARRIVALS_SCAN) {
      const room = Math.min(Math.floor((ARRIVALS_BYTES - bytes) / MAX_MESSAGE_ROW_BYTES), ARRIVALS_SCAN - seen)
      if (room < 1) break
      const batch = await ctx.db
        .query('messages')
        .withIndex('by_user_live', (q) => {
          const live = q.eq('userId', member.userId).eq('historical', false)
          return before === undefined ? live : live.lt('_creationTime', before)
        })
        .order('desc')
        .take(room)
      for (const message of batch) {
        latest ??= message._creationTime
        seen++
        bytes += byteSize(message)
        if ('self' in message.sender || message.redactedAt !== undefined) continue
        const chat = await ctx.db.get(message.chatId)
        if (!chat || chat.userId !== member.userId || chat.view !== 'inbox' || retired(chat)) continue
        out.push({
          arrivedAt: message._creationTime,
          message: clientLastMessage(lastOf(message)),
          chat: await rowFor(ctx, chat, accounts),
        })
        if (out.length === ARRIVALS) break scan
      }
      if (batch.length < room) break
      before = batch.at(-1)!._creationTime
    }
    return { latest, arrivals: out }
  },
})

// `messages.arrivals` returns exactly what @trioditis/core calls an `ArrivalFeed` of `Arrival`s.
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _arrivalMatchesCore: SameShape<keyof Infer<typeof arrival>, keyof Arrival> = true
const _feedMatchesCore: SameShape<keyof Infer<typeof arrivalFeed>, keyof ArrivalFeed> = true

/**
 * Sends a message. The client seals it twice: once to the bridge key (`forBridge`, kind
 * `outbound`, object ID `clientMessageId`), which the bridge host opens to send it, and once
 * to the person's own recipients (`copy`, kind `message`, object ID `clientMessageId`), which
 * is what Trioditis keeps until the network's echo replaces it.
 *
 * `clientMessageId` makes the send idempotent end to end: sending the same ID again does
 * nothing. Retrying a failed or unknown send uses a new ID, which the person chooses to do.
 * Returns `queued` for a new send, or what the ID was used for already and where that stands
 * (`alreadyUsed`), so a client can say what happened rather than report a send that wasn't
 * this one.
 */
export const send = mutation({
  args: {
    chatId: v.id('chats'),
    clientMessageId: v.string(),
    forBridge: envelope,
    copy: envelope,
    replyTo: v.optional(v.string()),
  },
  returns: v.union(v.literal('queued'), alreadyUsed),
  handler: async (ctx, { chatId, ...input }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    refuseRetryId(input.clientMessageId)
    // Sending the same message again does nothing, whatever has changed since.
    const used = await clientMessageIdUsed(ctx, member.userId, input.clientMessageId)
    if (used) return used
    await checkSend(ctx, chat, input)
    await queueSend(ctx, chat, input)
    return 'queued' as const
  },
})

const MAX_RETRY_STATES = 100

/**
 * Where sending each of these messages again stands, for any send in a chain (the original or
 * an attempt): the chain's original, its latest attempt and that one's delivery state, and
 * whether another may be made, with its client message ID (lib/retry.ts). IDs that aren't the
 * person's sends are left out.
 */
export const retryStates = query({
  args: { clientMessageIds: v.array(v.string()) },
  returns: v.array(v.object({ clientMessageId: v.string(), state: retryState })),
  handler: async (ctx, { clientMessageIds }) => {
    const member = await requireMember(ctx)
    if (clientMessageIds.length > MAX_RETRY_STATES)
      throw new ConvexError(`Ask for at most ${MAX_RETRY_STATES} at once.`)
    const out = []
    for (const clientMessageId of new Set(clientMessageIds)) {
      const plan = await retryPlan(ctx, member.userId, clientMessageId)
      if (!plan) continue
      const { next: _next, ...state } = plan
      out.push({ clientMessageId, state })
    }
    return out
  },
})

/**
 * Sends a message again: the next attempt of the chain `clientMessageId` belongs to (any send
 * in it), sealed by the client for `nextId` as `messages.send` takes it. Made only if the
 * server allows one now and `nextId` is the one it says (`retryStates`); otherwise nothing is
 * made, and `created` is false. So repeated clicks, other tabs and stale pages make one attempt
 * per link, and one that may have gone is never followed by another.
 */
export const sendAgain = mutation({
  args: {
    clientMessageId: v.string(),
    nextId: v.string(),
    forBridge: envelope,
    copy: envelope,
    replyTo: v.optional(v.string()),
  },
  returns: v.object({ created: v.boolean(), state: retryState }),
  handler: async (ctx, { clientMessageId, nextId, ...input }) => {
    const member = await requireMember(ctx)
    const plan = await retryPlan(ctx, member.userId, clientMessageId)
    if (!plan) throw new ConvexError('That message doesn’t exist.')
    const { next, ...state } = plan
    if (!plan.allowed || plan.nextId !== nextId) return { created: false, state }
    const chat = await ownChat(ctx, member.userId, next.chatId!)
    const send = { clientMessageId: nextId, ...input }
    await checkSend(ctx, chat, send)
    await queueSend(ctx, chat, send, { root: plan.root, of: next.of, index: next.index })
    const after = await retryPlan(ctx, member.userId, plan.root)
    const { next: _next, ...now } = after!
    return { created: true, state: now }
  },
})

/**
 * Discards a send whose outcome is unknown or that failed: the person decided not to risk a
 * duplicate. Its pending copy is removed; the outbox row stays for the record.
 */
export const discardSend = mutation({
  args: { clientMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { clientMessageId }) => {
    const member = await requireMember(ctx)
    const message = await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', member.userId).eq('clientMessageId', clientMessageId))
      .first()
    if (!message) return null
    if (message.delivery !== 'unknown' && message.delivery !== 'failed') {
      throw new ConvexError('Only a message that failed or may not have sent can be discarded.')
    }
    if (!message.eventId.startsWith('pending:')) {
      throw new ConvexError('This message reached the network, so it can’t be discarded here.')
    }
    await ctx.db.delete(message._id)
    const chat = await ctx.db.get(message.chatId)
    if (chat) await forgetMessage(ctx, chat, message._id)
    return null
  },
})

/**
 * A reaction key the client may send: one emoji (a joined sequence can run to a dozen code
 * units) or a network's short name for one, with no spaces or control characters.
 */
const REACTION_KEY = /^[^\s\p{Cc}]{1,64}$/u
/**
 * A reaction that hasn't reached the bridge host within this isn't sent: by then the person has
 * moved on, and it would turn up unexpectedly.
 */
const REACTION_TTL_MS = 10 * 60 * 1000

/**
 * Adds the person's reaction to a message, or with `remove` takes it away. The bridge host does
 * it on the network, and its echo (a `reaction` or `reactionRemove` event) is what changes
 * `messages.reactions`; nothing is stored until then. A network that allows one reaction per
 * person replaces the old one itself, and the bridge host reports that removal too.
 */
export const react = mutation({
  args: {
    chatId: v.id('chats'),
    messageId: v.id('messages'),
    key: v.string(),
    remove: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { chatId, messageId, key, remove }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    const info = NETWORK_INFO[chat.network]
    if (info && !info.reactions) throw new ConvexError(`${info.name} doesn’t have reactions.`)
    if (!REACTION_KEY.test(key)) throw new ConvexError('That reaction can’t be sent.')
    const message = await ctx.db.get(messageId)
    if (
      !message ||
      message.chatId !== chat._id ||
      message.eventId.startsWith('pending:') ||
      message.redactedAt !== undefined
    ) {
      throw new ConvexError('That message can’t be reacted to.')
    }
    const now = Date.now()
    await queueCommand(ctx, {
      userId: chat.userId,
      network: chat.network,
      loginId: chat.loginId,
      chatId: chat._id,
      payload: { type: remove ? 'unreact' : 'react', portalId: chat.portalId, targetEventId: message.eventId, key },
      state: 'queued',
      attempts: 0,
      createdAt: now,
      expiresAt: now + REACTION_TTL_MS,
    })
    return null
  },
})

/** The most reactions shown per message. */
const MAX_REACTIONS_PER_MESSAGE = 100
/**
 * The most of the person's own reactions added to a message that has more than the first 100:
 * theirs could be past those, and they need to see it to take it away.
 */
const MAX_OWN_REACTIONS = 20
/** The most `messages.reactions` reads of reaction rows, well under a query's 16 MiB. */
const MAX_REACTION_BYTES = 8 * 1024 * 1024
/**
 * The largest a reaction row can be: its key, event ID, sender and user ID are each capped
 * at 256 characters at ingest (`MAX_ID_LENGTH`), up to 3 bytes each in UTF-8, plus IDs.
 */
const MAX_REACTION_ROW_BYTES = 4 * 1024

/**
 * Active reactions on the given messages (at most 100 messages, 100 reactions each, and on a
 * message with that many, up to 20 more of the person's own that the first 100 left out). It never
 * reads the messages themselves, which can be large: a reaction row says whose it is, and a
 * deleted message's reactions are hidden by its clean-up marker until they're removed.
 *
 * It reads at most `MAX_REACTION_BYTES` of reactions, starting a message only while a full
 * one's worth of the largest rows still fits, so messages it didn't get to are left out of
 * the result, as a deleted one still being cleaned up is. Every other message gets a list,
 * empty if it has no reactions (or isn't the person's).
 */
export const reactions = query({
  args: { chatId: v.id('chats'), messageIds: v.array(v.id('messages')) },
  handler: async (ctx, { chatId, messageIds }) => {
    const member = await requireMember(ctx)
    if (messageIds.length > 100) throw new ConvexError('Ask for at most 100 messages’ reactions at once.')
    // The chat row isn't read unless a message is being cleaned up: it changes with every
    // message, and reading it ran every open chat's reactions again on each one. Only the
    // person's own rows are read, so another's chat gets empty lists, whatever is in it.
    const out: Record<string, { key: string; senderKey: string }[]> = {}
    let own: Promise<boolean> | undefined
    const isOwnChat = () => (own ??= ctx.db.get(chatId).then((chat) => chat !== null && chat.userId === member.userId))
    // A message's rows and the bytes read for them, or null for one left out: deleted in this chat.
    const one = async (messageId: Id<'messages'>) => {
      const deleted = await ctx.db
        .query('reactionCleanups')
        .withIndex('by_message', (q) => q.eq('messageId', messageId))
        .first()
      // A marker says nothing unless the chat is the person's: which messages of a chat are
      // being deleted is its owner's to know, so for anyone else it's as if there were none.
      if (deleted && (await isOwnChat())) {
        // A deleted message in this chat is left out; one in another chat isn't this chat's,
        // so it gets an empty list like any other ID that isn't a message here.
        return deleted.chatId !== undefined && deleted.chatId !== chatId ? { rows: [], read: 0 } : null
      }
      const rows = await ctx.db
        .query('reactions')
        .withIndex('by_user_message_active', (q) =>
          q.eq('userId', member.userId).eq('messageId', messageId).eq('removedAt', undefined),
        )
        .take(MAX_REACTIONS_PER_MESSAGE)
      let read = byteSize(rows)
      if (rows.length === MAX_REACTIONS_PER_MESSAGE) {
        const seen = new Set(rows.map((row) => row._id))
        const own = await ctx.db
          .query('reactions')
          .withIndex('by_message_sender_active', (q) =>
            q.eq('messageId', messageId).eq('senderKey', 'self').eq('removedAt', undefined),
          )
          .take(MAX_OWN_REACTIONS)
        rows.push(...own.filter((row) => !seen.has(row._id)))
        read += byteSize(own)
      }
      return { rows, read }
    }
    // The messages are read a batch at a time, all of a batch at once: one after another, each
    // of a page's 200 reads waits for the last. A batch is as many messages as the budget left
    // could hold at their largest, so it stops where reading one by one would have: at the
    // first message that might not fit.
    const worst = (MAX_REACTIONS_PER_MESSAGE + MAX_OWN_REACTIONS) * MAX_REACTION_ROW_BYTES
    let bytes = 0
    let next = 0
    while (next < messageIds.length) {
      const room = Math.floor((MAX_REACTION_BYTES - bytes) / worst)
      if (room < 1) break
      const batch = messageIds.slice(next, next + room)
      next += batch.length
      const lists = await Promise.all(batch.map(one))
      batch.forEach((messageId, i) => {
        const list = lists[i]
        if (!list) return
        bytes += list.read
        out[messageId] = list.rows
          .filter((row) => row.userId === member.userId && row.chatId === chatId && row.removedAt === undefined)
          .map(({ key, senderKey }) => ({ key, senderKey }))
      })
    }
    return out
  },
})

/**
 * The rest of a read receipt's marking of the person's own messages, when one transaction
 * couldn't look through them all (lib/ingest.ts, markOwnReadRange).
 */
export const markOwnReadRange = internalMutation({
  args: { chatId: v.id('chats'), after: v.union(v.null(), v.string()), upTo: v.string() },
  returns: v.null(),
  handler: async (ctx, { chatId, after, upTo }) => {
    await markRange(ctx, chatId, after, upTo)
    return null
  },
})

/** How far each participant has read in a chat: `senderKey` is `self` or `ghost:<ghostId>`. */
export const receipts = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    const rows = await ctx.db
      .query('receipts')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(500)
    return rows.map(({ senderKey, upToEventId, networkTs }) => ({ senderKey, upToEventId, networkTs }))
  },
})

/**
 * Who is typing in a chat. Each row says until when; the client hides rows once `expiresAt`
 * has passed, since a query doesn't rerun just because time passes.
 */
export const typing = query({
  args: { chatId: v.id('chats') },
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    await ownChat(ctx, member.userId, chatId)
    const now = Date.now()
    const rows = await ctx.db
      .query('typing')
      .withIndex('by_chat_expires', (q) => q.eq('chatId', chatId).gt('expiresAt', now))
      .take(100)
    return rows.map(({ senderKey, expiresAt }) => ({ senderKey, expiresAt }))
  },
})

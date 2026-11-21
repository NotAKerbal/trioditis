import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'
import { isEnvelope } from './lib/envelope'
import { LOGIN_COMMAND_TTL_MS, queueCommand } from './lib/outbox'
import { envelope, errorCode } from './validators'

// Starting a chat: with one of the person's contacts, or with whoever a phone number or
// username belongs to. The identifier is sealed to the bridge key (kind `outbound`, object ID
// `requestId`), so the server never sees it; the bridge host answers with `chatStarted`. See
// client-api.md, New chats.

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
/** A phone number or username, sealed: far less than this. */
const MAX_IDENTIFIER_SEALED_BYTES = 4 * 1024
/** How many chats one person can start a minute: enough to work through a list, not to probe a network. */
const STARTS_PER_MINUTE = 20
/** Requests are kept a day, for a page that was closed while one was on its way. */
const KEEP_MS = 24 * 60 * 60 * 1000
const PRUNE_BATCH = 500

/**
 * Asks a connected account's network for a direct chat, by `ghostId` (a contact the person has
 * on that network) or `sealedIdentifier` (`{ identifier }`, sealed for the bridge key). Calling
 * it again with the same `requestId` does nothing. Watch `newChats.status` for the outcome.
 */
export const start = mutation({
  args: {
    networkAccountId: v.id('networkAccounts'),
    requestId: v.string(),
    ghostId: v.optional(v.string()),
    sealedIdentifier: v.optional(envelope),
    sessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { networkAccountId, requestId, ghostId, sealedIdentifier, sessionId }) => {
    // The identifier was sealed for this page's account: refused if another tab switched it.
    await requireSessionIfGiven(ctx, sessionId)
    const member = await requireMember(ctx)
    if (!REQUEST_ID.test(requestId)) throw new ConvexError('That request ID isn’t valid.')
    if ((ghostId === undefined) === (sealedIdentifier === undefined)) {
      throw new ConvexError('Start a chat with a contact or a sealed identifier.')
    }
    const account = await ctx.db.get(networkAccountId)
    if (!account || account.userId !== member.userId) throw new ConvexError('That account doesn’t exist.')
    if (account.state !== 'CONNECTED') throw new ConvexError('That account isn’t connected.')
    const existing = await ctx.db
      .query('chatStarts')
      .withIndex('by_request', (q) => q.eq('userId', member.userId).eq('requestId', requestId))
      .unique()
    if (existing) return null
    if (sealedIdentifier && !isEnvelope(sealedIdentifier, MAX_IDENTIFIER_SEALED_BYTES)) {
      throw new ConvexError('That identifier isn’t sealed, or is too long.')
    }
    if (ghostId !== undefined) {
      const contact = await ctx.db
        .query('contacts')
        .withIndex('by_ghost', (q) =>
          q.eq('userId', member.userId).eq('network', account.network).eq('ghostId', ghostId),
        )
        .unique()
      if (!contact) throw new ConvexError('That contact doesn’t exist.')
      // A contact's ID can belong to the login that sent it, so its chat starts on an account
      // that has sent it.
      if (contact.accountIds?.length && !contact.accountIds.includes(networkAccountId)) {
        throw new ConvexError('That contact is on another of your accounts.')
      }
    }
    const now = Date.now()
    const recent = await ctx.db
      .query('chatStarts')
      .withIndex('by_user_createdAt', (q) => q.eq('userId', member.userId).gt('createdAt', now - 60_000))
      .take(STARTS_PER_MINUTE)
    if (recent.length >= STARTS_PER_MINUTE) throw new ConvexError('Too many new chats. Wait a minute, then try again.')
    const commandId = await queueCommand(
      ctx,
      {
        userId: member.userId,
        network: account.network,
        loginId: account.loginId,
        payload: { type: 'startChat', requestId, ...(ghostId !== undefined ? { ghostId } : {}) },
        state: 'queued',
        attempts: 0,
        createdAt: now,
        expiresAt: now + LOGIN_COMMAND_TTL_MS,
      },
      sealedIdentifier,
    )
    await ctx.db.insert('chatStarts', {
      userId: member.userId,
      network: account.network,
      loginId: account.loginId,
      requestId,
      commandId,
      state: 'pending',
      createdAt: now,
    })
    return null
  },
})

/** How a request to start a chat is going: `pending`, `started` with its chat, or `failed` with why. */
export const status = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      state: v.union(v.literal('pending'), v.literal('started'), v.literal('failed')),
      chatId: v.optional(v.id('chats')),
      error: v.optional(errorCode),
    }),
  ),
  handler: async (ctx, { requestId }) => {
    const member = await requireMember(ctx)
    const request = await ctx.db
      .query('chatStarts')
      .withIndex('by_request', (q) => q.eq('userId', member.userId).eq('requestId', requestId))
      .unique()
    if (!request) return null
    return {
      state: request.state,
      ...(request.chatId ? { chatId: request.chatId } : {}),
      ...(request.error ? { error: request.error } : {}),
    }
  },
})

/** Deletes requests over a day old, a batch at a time, until none are left. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query('chatStarts')
      .withIndex('by_createdAt', (q) => q.lt('createdAt', Date.now() - KEEP_MS))
      .take(PRUNE_BATCH)
    for (const row of old) await ctx.db.delete(row._id)
    // People can start more an hour than one batch holds; the rest go straight after.
    if (old.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.newChats.prune, {})
    return null
  },
})

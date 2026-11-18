import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMember } from './lib/access'
import { backupsOf, keyState } from './keys'
import { audit } from './lib/audit'
import { MAX_CLIENT_SEALED_BYTES, isEnvelope } from './lib/envelope'
import { LOGIN_COMMAND_TTL_MS, queueCommand } from './lib/outbox'
import { enabledNetworks } from './lib/networks'
import { envelope, errorCode, loginState, loginStep, network } from './validators'

// Connecting a network account. The bridge host drives the login's steps (QR codes,
// pairing codes, cookies), which arrive as `loginStep` events on the session. What the
// person types is sealed to the bridge key, never stored in plaintext.

/** The person's connected network accounts, including ones that need attention. */
export const accounts = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('networkAccounts'),
      network,
      state: loginState,
      error: v.union(v.null(), errorCode),
      lastHealthyAt: v.union(v.null(), v.number()),
      updatedAt: v.number(),
      /** A logout was asked for and hasn't been confirmed yet. */
      logoutPending: v.boolean(),
      /** Why the last logout didn't happen, if it didn't. */
      logoutError: v.union(v.null(), errorCode),
    }),
  ),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const rows = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    return rows.map((row) => ({
      _id: row._id,
      network: row.network,
      state: row.state,
      error: row.error ?? null,
      lastHealthyAt: row.lastHealthyAt ?? null,
      updatedAt: row.updatedAt,
      logoutPending: row.logoutPending ?? false,
      logoutError: row.logoutError ?? null,
    }))
  },
})

/**
 * A login in progress, for the stepper: `step` is what to show now (a QR code, a pairing code,
 * fields to fill in, cookies to paste), and `state` says when it's over.
 */
export const session = query({
  args: { loginSessionId: v.id('loginSessions') },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id('loginSessions'),
      network,
      state: v.union(
        v.literal('pending'),
        v.literal('active'),
        v.literal('complete'),
        v.literal('cancelled'),
        v.literal('error'),
      ),
      step: v.union(v.null(), loginStep),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, { loginSessionId }) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(loginSessionId)
    if (!session || session.userId !== member.userId) return null
    return {
      _id: session._id,
      network: session.network,
      state: session.state,
      step: session.step ?? null,
      updatedAt: session.updatedAt,
    }
  },
})

export const start = mutation({
  args: { network, flowId: v.optional(v.string()) },
  returns: v.id('loginSessions'),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    // Login flow IDs are short names like `qr` or `phone`; anything else isn't one.
    if (args.flowId !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(args.flowId)) {
      throw new ConvexError('That isn’t a login method this network offers.')
    }
    if (!enabledNetworks().has(args.network)) throw new ConvexError('That network isn’t enabled on this server.')
    // Nothing can be sealed to someone without an identity key, and a key without both backups
    // could be lost with the device, so no network can be connected until both exist.
    if (keyState(member, await backupsOf(ctx, member.userId)) !== 'ready') {
      throw new ConvexError('Finish setting up your key, with its password and recovery key, before connecting a network.')
    }
    const now = Date.now()
    const loginSessionId = await ctx.db.insert('loginSessions', {
      userId: member.userId,
      network: args.network,
      state: 'pending',
      updatedAt: now,
    })
    await queueCommand(ctx, {
      userId: member.userId,
      network: args.network,
      payload: {
        type: 'loginStart',
        loginSessionId,
        network: args.network,
        ...(args.flowId ? { flowId: args.flowId } : {}),
      },
      state: 'queued',
      attempts: 0,
      createdAt: now,
      expiresAt: now + LOGIN_COMMAND_TTL_MS,
    })
    await audit(ctx, { kind: 'user', id: member.userId }, 'login.start', args.network)
    return loginSessionId
  },
})

/** Submits a step's input, sealed to the bridge key with object ID `<loginSessionId>/<stepId>`. */
export const submit = mutation({
  args: { loginSessionId: v.id('loginSessions'), stepId: v.string(), sealed: envelope },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(args.loginSessionId)
    if (!session || session.userId !== member.userId) throw new ConvexError('That login doesn’t exist.')
    if (args.stepId.length > 256 || session.state !== 'active' || session.step?.stepId !== args.stepId) {
      throw new ConvexError('That step of the login is over. Start again if it didn’t finish.')
    }
    if (!isEnvelope(args.sealed, MAX_CLIENT_SEALED_BYTES))
      throw new ConvexError('That input isn’t sealed, or is too long.')
    const now = Date.now()
    await queueCommand(
      ctx,
      {
        userId: member.userId,
        network: session.network,
        payload: { type: 'loginSubmit', loginSessionId: args.loginSessionId, stepId: args.stepId },
        // The login runs inside the bridge host that started it.
        ...(session.hostId ? { hostId: session.hostId } : {}),
        state: 'queued',
        attempts: 0,
        createdAt: now,
        // Credentials don't wait around for a bridge host that never comes back.
        expiresAt: now + LOGIN_COMMAND_TTL_MS,
      },
      args.sealed,
    )
    return null
  },
})

export const cancel = mutation({
  args: { loginSessionId: v.id('loginSessions') },
  returns: v.null(),
  handler: async (ctx, { loginSessionId }) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(loginSessionId)
    if (!session || session.userId !== member.userId) throw new ConvexError('That login doesn’t exist.')
    if (session.state === 'complete' || session.state === 'cancelled') return null
    const now = Date.now()
    await queueCommand(ctx, {
      userId: member.userId,
      network: session.network,
      payload: { type: 'loginCancel', loginSessionId },
      ...(session.hostId ? { hostId: session.hostId } : {}),
      state: 'queued',
      attempts: 0,
      createdAt: now,
      expiresAt: now + LOGIN_COMMAND_TTL_MS,
    })
    return null
  },
})

/**
 * Disconnects a network account: the bridge host logs it out of the network. The account's
 * chats stay in Trioditis; its state becomes `LOGGED_OUT` when the bridge host reports it.
 */
export const logout = mutation({
  args: { networkAccountId: v.id('networkAccounts') },
  returns: v.null(),
  handler: async (ctx, { networkAccountId }) => {
    const member = await requireMember(ctx)
    const account = await ctx.db.get(networkAccountId)
    if (!account || account.userId !== member.userId) throw new ConvexError('That account doesn’t exist.')
    if (account.state === 'LOGGED_OUT' || account.logoutPending) return null
    const now = Date.now()
    await ctx.db.patch(account._id, { logoutPending: true, logoutError: undefined })
    await queueCommand(ctx, {
      userId: member.userId,
      network: account.network,
      loginId: account.loginId,
      payload: { type: 'logout' },
      state: 'queued',
      attempts: 0,
      createdAt: now,
      expiresAt: now + LOGIN_COMMAND_TTL_MS,
    })
    await audit(ctx, { kind: 'user', id: member.userId }, 'login.logout', account.network)
    return null
  },
})

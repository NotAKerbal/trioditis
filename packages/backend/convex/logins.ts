import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMember } from './lib/access'
import { audit } from './lib/audit'
import { MAX_CLIENT_SEALED_BYTES, isEnvelope } from './lib/envelope'
import { LOGIN_COMMAND_TTL_MS, queueCommand } from './lib/outbox'
import { enabledNetworks } from './lib/networks'
import { envelope, network } from './validators'

// Connecting a network account. The bridge host drives the login's steps (QR codes,
// pairing codes, cookies), which arrive as `loginStep` events on the session. What the
// person types is sealed to the bridge key, never stored in plaintext.

export const accounts = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    return await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .collect()
  },
})

export const session = query({
  args: { loginSessionId: v.id('loginSessions') },
  handler: async (ctx, { loginSessionId }) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(loginSessionId)
    if (!session || session.userId !== member.userId) return null
    return session
  },
})

export const start = mutation({
  args: { network, flowId: v.optional(v.string()) },
  returns: v.id('loginSessions'),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    if (!enabledNetworks().has(args.network)) throw new ConvexError('That network isn’t enabled on this server.')
    // Nothing can be sealed to someone without an identity key, so no network can be
    // connected until their first device has set one.
    if (!member.identityPublicKey) throw new ConvexError('Finish setting up this device before connecting a network.')
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
    if (session.state !== 'active' || session.step?.stepId !== args.stepId) {
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

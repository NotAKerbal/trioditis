import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { BRIDGE_HOST_STALE_MS, NETWORK_INFO } from '@trioditis/core'
import { mutation, query, type QueryCtx } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'
import { backupsOf, keyState } from './keys'
import { hmacBase64url, randomToken, sha256Hex } from './lib/hash'
import { audit } from './lib/audit'
import { MAX_CLIENT_SEALED_BYTES, isEnvelope } from './lib/envelope'
import { LOGIN_COMMAND_TTL_MS, queueCommand, queueLoginCancel, queueLogout } from './lib/outbox'
import { offeredNetworks, retired } from './lib/networks'
import { envelope, errorCode, loginState, loginStep, network } from './validators'

// Connecting a network account. The bridge host drives the login's steps (QR codes,
// pairing codes, cookies), which arrive as `loginStep` events on the session. What the
// person types is sealed to the bridge key, never stored in plaintext.

/**
 * How the person tells two of their accounts on one network apart, as far as the backend can:
 * the end of its login ID. The login ID is the bridge host's keyed hash, so it never reads as a
 * phone number; what does (the number, a username) comes sealed to the owner (`sealedMeta`,
 * kind `account`), and their device shows that in place of this. Only the account's owner is
 * ever given either.
 */
export function accountHint(loginId: string): string {
  return loginId.length > 4 ? `ID …${loginId.slice(-4)}` : loginId ? `ID ${loginId}` : ''
}

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
      /** What tells it apart from the person's other accounts on the network (accountHint). */
      hint: v.string(),
      /**
       * What tells it apart, as the bridge host put it (`AccountPlaintext`): open with kind
       * `account` and object ID `objectId`, and show its `hint` in place of `hint`. Null until
       * the bridge host has said.
       */
      sealedMeta: v.union(v.null(), v.object({ sealed: envelope, objectId: v.string() })),
      /** A logout was asked for and hasn't been confirmed yet. */
      logoutPending: v.boolean(),
      /** Why the last logout didn't happen, if it didn't. */
      logoutError: v.union(v.null(), errorCode),
      /** A login the person cancelled connected it anyway: they keep it (logins.keep) or disconnect it. */
      connectedAfterCancel: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const rows = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    return rows
      .filter((row) => !retired(row))
      .map((row) => ({
        _id: row._id,
        network: row.network,
        state: row.state,
        error: row.error ?? null,
        lastHealthyAt: row.lastHealthyAt ?? null,
        updatedAt: row.updatedAt,
        hint: accountHint(row.loginId),
        sealedMeta: row.sealedMeta ? { sealed: row.sealedMeta, objectId: row.loginId } : null,
        logoutPending: row.logoutPending ?? false,
        logoutError: row.logoutError ?? null,
        connectedAfterCancel: row.connectedAfterCancel ?? false,
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
      /**
       * When the bridge host running the login (or, before one has it, the network's most
       * recently seen host) was last heard from; null if none ever was. The stepper compares it
       * with its own clock, so a QR or pairing code from a host that has gone away isn't left up.
       */
      hostLastSeenAt: v.union(v.null(), v.number()),
      /** Whether that host had been heard from in the last two minutes when this ran. */
      hostOnline: v.boolean(),
    }),
  ),
  handler: async (ctx, { loginSessionId }) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(loginSessionId)
    if (!session || session.userId !== member.userId || retired(session)) return null
    const seenAt = await hostLastSeenAt(ctx, session)
    return {
      _id: session._id,
      network: session.network,
      state: session.state,
      step: session.step ?? null,
      updatedAt: session.updatedAt,
      hostLastSeenAt: seenAt,
      hostOnline: seenAt !== null && Date.now() - seenAt <= BRIDGE_HOST_STALE_MS,
    }
  },
})

async function hostLastSeenAt(ctx: QueryCtx, session: Doc<'loginSessions'>) {
  const hostId = session.hostId
  if (hostId) {
    const host = await ctx.db
      .query('bridgeHosts')
      .withIndex('by_hostId', (q) => q.eq('hostId', hostId))
      .first()
    return host?.lastSeenAt ?? null
  }
  const hosts = await ctx.db.query('bridgeHosts').take(100)
  const seen = hosts.filter((host) => host.network === session.network).map((host) => host.lastSeenAt)
  return seen.length ? Math.max(...seen) : null
}

export const start = mutation({
  args: { network, flowId: v.optional(v.string()), sessionId: v.optional(v.string()) },
  returns: v.id('loginSessions'),
  handler: async (ctx, args) => {
    // A login started from a page another tab's sign-in has switched would connect the
    // network to the other account, whose key then seals what it brings in.
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    if (!(await offeredNetworks(ctx)).has(args.network)) {
      throw new ConvexError('That network isn’t installed on this server.')
    }
    // Only the flows `networks.list` offers for this network. Without one, the bridge host
    // uses the network's first.
    if (args.flowId !== undefined && !NETWORK_INFO[args.network].flows.some((flow) => flow.id === args.flowId)) {
      throw new ConvexError('That isn’t a login method this network offers.')
    }
    // Nothing can be sealed to someone without an identity key, and a key without both backups
    // could be lost with the device, so no network can be connected until both exist.
    if (keyState(member, await backupsOf(ctx, member.userId)) !== 'ready') {
      throw new ConvexError(
        'Finish setting up your key, with its password and recovery key, before connecting a network.',
      )
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
    // A step takes one submission: the bridge host refuses a second, and that refusal would
    // otherwise end a login the first submission is still moving along.
    if (session.submittedStepId === args.stepId)
      throw new ConvexError('That’s already been sent. Wait for the next step.')
    if (!isEnvelope(args.sealed, MAX_CLIENT_SEALED_BYTES))
      throw new ConvexError('That input isn’t sealed, or is too long.')
    const now = Date.now()
    await ctx.db.patch(session._id, { submittedStepId: args.stepId })
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

/** How long a sign-in browser ticket lasts before the gateway must have redeemed it. */
export const SIGNIN_TICKET_TTL_MS = 60_000

/**
 * Whether a login is on `stepId` and that step runs in the sign-in browser: only then may a
 * ticket to it be issued or redeemed.
 */
export function browserStepOpen(session: Doc<'loginSessions'>, stepId: string) {
  const step = session.step
  return (
    session.state === 'active' &&
    step?.stepId === stepId &&
    step.type === 'cookies' &&
    step.cookies?.browser === true &&
    !!session.hostId
  )
}

/**
 * A ticket to the sign-in browser of a login's current step, for opening its websocket
 * through the gateway (docs/architecture/signin-browser.md). It lasts a minute and works once.
 */
/**
 * The admission that lets a socket wait for its ticket at the gateway, in the socket's address:
 * `<person>.<expiresAt>.<mac>`, where `person` is a hash of the person's ID and `mac` is
 * HMAC-SHA256 under GATEWAY_SECRET of `login-browser-admission\n<person>.<expiresAt>`. It
 * proves the socket was asked for by a signed-in person, so the gateway turns away every other
 * before it takes a place, and counts the rest by person (docs/architecture/signin-browser.md,
 * Tickets). It is no use without the ticket, which goes in the first message.
 */
async function admission(userId: string, expiresAt: number): Promise<string> {
  const secret = process.env.GATEWAY_SECRET
  if (!secret) throw new ConvexError('This server can’t show the sign-in page.')
  const person = (await sha256Hex(`trioditis/login-browser/${userId}`)).slice(0, 32)
  const payload = `${person}.${expiresAt}`
  return `${payload}.${await hmacBase64url(secret, `login-browser-admission\n${payload}`)}`
}

export const openBrowser = mutation({
  args: { loginSessionId: v.id('loginSessions'), stepId: v.string(), sessionId: v.optional(v.string()) },
  returns: v.object({ ticket: v.string(), admission: v.string() }),
  handler: async (ctx, args) => {
    // The browser signs the network in for whoever owns the login, so a page another tab has
    // signed into someone else can't open it.
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    const session = await ctx.db.get(args.loginSessionId)
    if (!session || session.userId !== member.userId) throw new ConvexError('That login doesn’t exist.')
    if (!browserStepOpen(session, args.stepId)) {
      throw new ConvexError('That step of the login can’t be opened in a browser. Start again if it didn’t finish.')
    }
    // One ticket at a time: an earlier one that was never used goes.
    const earlier = await ctx.db
      .query('signinTickets')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(20)
    for (const ticket of earlier) await ctx.db.delete(ticket._id)
    const token = randomToken(32)
    const expiresAt = Date.now() + SIGNIN_TICKET_TTL_MS
    await ctx.db.insert('signinTickets', {
      tokenHash: await sha256Hex(token),
      loginSessionId: session._id,
      userId: member.userId,
      hostId: session.hostId!,
      stepId: args.stepId,
      expiresAt,
    })
    return { ticket: token, admission: await admission(member.userId, expiresAt) }
  },
})

/**
 * Cancels a login, and says how it ended: `cancelled`, or `complete` or `error` when it had
 * already ended that way. Asking twice changes nothing. The login ends here, not only when
 * the bridge host confirms, so a step it sends meanwhile can't bring it back; one that
 * finished on the bridge host anyway keeps its account, flagged for the person to keep or
 * disconnect (lib/ingest.ts).
 */
export const cancel = mutation({
  args: { loginSessionId: v.id('loginSessions') },
  returns: v.union(v.literal('cancelled'), v.literal('complete'), v.literal('error')),
  handler: async (ctx, { loginSessionId }) => {
    const member = await requireMember(ctx)
    const session = await ctx.db.get(loginSessionId)
    if (!session || session.userId !== member.userId) throw new ConvexError('That login doesn’t exist.')
    if (session.state === 'complete' || session.state === 'cancelled') return session.state
    // One that ended in an error here (a command that timed out) may still be running on the
    // bridge host, so it's told to stop too, but the error stays what the person sees.
    await queueLoginCancel(ctx, session)
    if (session.state === 'error') return 'error'
    await ctx.db.patch(session._id, { state: 'cancelled', updatedAt: Date.now() })
    return 'cancelled'
  },
})

/**
 * Disconnects a network account: the bridge host logs it out of the network. The account's
 * chats stay in Trioditis; its state becomes `LOGGED_OUT` when the bridge host reports it.
 * Says what happened, so the app doesn't announce a disconnect that wasn't asked for again:
 * `queued`, or `pending` when one is already on its way, or `loggedOut` when it already is.
 */
export const logout = mutation({
  args: { networkAccountId: v.id('networkAccounts') },
  returns: v.union(v.literal('queued'), v.literal('pending'), v.literal('loggedOut')),
  handler: async (ctx, { networkAccountId }) => {
    const member = await requireMember(ctx)
    const account = await ctx.db.get(networkAccountId)
    if (!account || account.userId !== member.userId) throw new ConvexError('That account doesn’t exist.')
    // Decided: whatever a cancelled login did, the person chose to disconnect it.
    if (account.connectedAfterCancel) await ctx.db.patch(account._id, { connectedAfterCancel: undefined })
    if (account.state === 'LOGGED_OUT') return 'loggedOut'
    if (!(await queueLogout(ctx, account))) return 'pending'
    await audit(ctx, { kind: 'user', id: member.userId }, 'login.logout', account.network)
    return 'queued'
  },
})

/**
 * Keeps an account a login the person cancelled connected anyway (`connectedAfterCancel`):
 * they've decided it stays, so it stops asking.
 */
export const keep = mutation({
  args: { networkAccountId: v.id('networkAccounts') },
  returns: v.null(),
  handler: async (ctx, { networkAccountId }) => {
    const member = await requireMember(ctx)
    const account = await ctx.db.get(networkAccountId)
    if (!account || account.userId !== member.userId) throw new ConvexError('That account doesn’t exist.')
    if (account.connectedAfterCancel) await ctx.db.patch(account._id, { connectedAfterCancel: undefined })
    return null
  },
})

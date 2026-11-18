import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server'
import { currentSession, requireSessionIfGiven } from './auth'
import { requireAdmin } from './lib/access'
import { constantTimeEqual, randomToken, sha256Hex } from './lib/hash'
import { audit } from './lib/audit'

// Who is on this server. Accounts start from an invitation; the first account, the admin,
// starts from the setup token the installer generates (TRIODITIS_SETUP_TOKEN).

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** How long a sign-up holds an invitation or the setup token while its account is created. */
const RESERVATION_MS = 10 * 60 * 1000

const role = v.union(v.literal('admin'), v.literal('member'))

async function hasMembers(ctx: QueryCtx) {
  return (await ctx.db.query('members').first()) !== null
}

async function setupTokenMatches(tokenHash: string | undefined) {
  const setupToken = process.env.TRIODITIS_SETUP_TOKEN
  if (!setupToken || !tokenHash) return false
  return constantTimeEqual(await sha256Hex(setupToken), tokenHash)
}

/**
 * The invitation `tokenHash` names for `email`, if it can still be used. One held for a
 * sign-up in progress stays usable until that sign-up finishes, even if it expires meanwhile.
 */
async function openInvitation(ctx: QueryCtx, email: string, tokenHash: string | undefined) {
  if (!tokenHash) return null
  const invitation = await ctx.db
    .query('invitations')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .unique()
  const now = Date.now()
  const held = (invitation?.reservedUntil ?? 0) > now
  if (!invitation || invitation.acceptedAt || (invitation.expiresAt < now && !held)) return null
  if (invitation.email !== normalizeEmail(email)) return null
  return invitation
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

async function setupReservation(ctx: QueryCtx) {
  return await ctx.db
    .query('serverState')
    .withIndex('by_key', (q) => q.eq('key', 'setup'))
    .unique()
}

/**
 * Admits one sign-up, before Better Auth creates its account. In this transaction it holds
 * the setup token or the invitation for that sign-up for a few minutes, so two sign-ups
 * racing for one can't both get an account: the second is refused before it has one.
 */
export const reserveAdmission = internalMutation({
  args: { email: v.string(), tokenHash: v.optional(v.string()) },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { email, tokenHash }) => {
    const now = Date.now()
    const address = normalizeEmail(email)
    if (!(await hasMembers(ctx))) {
      if (!(await setupTokenMatches(tokenHash))) return { allowed: false }
      const held = await setupReservation(ctx)
      if (held && held.reservedUntil > now && held.reservedEmail !== address) return { allowed: false }
      if (held) await ctx.db.patch(held._id, { reservedUntil: now + RESERVATION_MS, reservedEmail: address })
      else
        await ctx.db.insert('serverState', {
          key: 'setup',
          reservedUntil: now + RESERVATION_MS,
          reservedEmail: address,
        })
      return { allowed: true }
    }
    const invitation = await openInvitation(ctx, address, tokenHash)
    if (!invitation || (invitation.reservedUntil ?? 0) > now) return { allowed: false }
    await ctx.db.patch(invitation._id, { reservedUntil: now + RESERVATION_MS })
    return { allowed: true }
  },
})

/**
 * Makes the new account a member, completing what `reserveAdmission` held for it. An account
 * created without a matching reservation (which the hook order rules out) gets no membership,
 * and with none it can do nothing on this server.
 */
export const onAccountCreated = internalMutation({
  args: { userId: v.string(), email: v.string(), tokenHash: v.optional(v.string()) },
  returns: v.object({ admitted: v.boolean() }),
  handler: async (ctx, { userId, email, tokenHash }) => {
    const now = Date.now()
    const address = normalizeEmail(email)
    if (!(await hasMembers(ctx))) {
      const held = await setupReservation(ctx)
      if (!(await setupTokenMatches(tokenHash)) || !held || held.reservedEmail !== address) return { admitted: false }
      await ctx.db.insert('members', { userId, role: 'admin', createdAt: now })
      await ctx.db.delete(held._id)
      await audit(ctx, { kind: 'user', id: userId }, 'server.setup')
      return { admitted: true }
    }
    const invitation = await openInvitation(ctx, address, tokenHash)
    if (!invitation) return { admitted: false }
    await ctx.db.patch(invitation._id, { acceptedAt: now, acceptedBy: userId, reservedUntil: undefined })
    await ctx.db.insert('members', { userId, role: invitation.role, createdAt: now })
    await audit(ctx, { kind: 'user', id: userId }, 'invitation.accept', invitation._id)
    return { admitted: true }
  },
})

/** Whether `userId` is a member. MCP consent and every member function require it. */
export const isMember = internalQuery({
  args: { userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => {
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
    return member !== null
  },
})

/**
 * Who is signed in, and their membership: null when signed out, and `member: null` when the
 * account isn't a member of this server. The identity comes in the same result as the
 * membership, so the app never pairs one account's membership with another's session (for
 * example when another tab signs in as someone else). `sessionId` is the Better Auth
 * session's ID, as `getSession` gives it in `session.id`.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.string(),
      sessionId: v.string(),
      member: v.union(v.null(), v.object({ userId: v.string(), role, identityKid: v.union(v.string(), v.null()) })),
    }),
  ),
  handler: async (ctx) => {
    const session = await currentSession(ctx)
    if (!session) return null
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', session.userId))
      .unique()
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      member: member ? { userId: member.userId, role: member.role, identityKid: member.identityKid ?? null } : null,
    }
  },
})

/**
 * Creates an invitation and returns its token, once. The admin shares the link; only the
 * token's hash is stored.
 */
export const invite = mutation({
  args: { email: v.string(), role, sessionId: v.optional(v.string()) },
  returns: v.object({ invitationId: v.id('invitations'), token: v.string() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    // A demo deployment (previews, nightly) has a shared, published login; nobody can be
    // invited into it, so it can never hold a real person's account.
    if (process.env.TRIODITIS_DEMO === '1') throw new ConvexError('Invitations are turned off on demo servers.')
    const email = normalizeEmail(args.email)
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ConvexError('That isn’t an email address.')
    const token = randomToken()
    const invitationId = await ctx.db.insert('invitations', {
      email,
      tokenHash: await sha256Hex(token),
      role: args.role,
      invitedBy: admin.userId,
      expiresAt: Date.now() + INVITATION_TTL_MS,
    })
    await audit(ctx, { kind: 'user', id: admin.userId }, 'invitation.create', invitationId)
    return { invitationId, token }
  },
})

export const invitations = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const rows = await ctx.db.query('invitations').order('desc').take(100)
    return rows.map(({ tokenHash: _tokenHash, ...invitation }) => invitation)
  },
})

export const revokeInvitation = mutation({
  args: { invitationId: v.id('invitations') },
  returns: v.null(),
  handler: async (ctx, { invitationId }) => {
    const admin = await requireAdmin(ctx)
    const invitation = await ctx.db.get(invitationId)
    if (!invitation || invitation.acceptedAt) throw new ConvexError('That invitation can’t be revoked.')
    if ((invitation.reservedUntil ?? 0) > Date.now()) {
      throw new ConvexError('Someone is signing up with that invitation right now. Try again in a few minutes.')
    }
    await ctx.db.delete(invitationId)
    await audit(ctx, { kind: 'user', id: admin.userId }, 'invitation.revoke', invitationId)
    return null
  },
})

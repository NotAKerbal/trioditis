import { ConvexError, v } from 'convex/values'
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server'
import { requireAdmin, requireMember } from './lib/access'
import { constantTimeEqual, randomToken, sha256Hex } from './lib/hash'
import { audit } from './lib/audit'

// Who is on this server. Accounts start from an invitation; the first account, the admin,
// starts from the setup token the installer generates (TRIODITIS_SETUP_TOKEN).

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

const role = v.union(v.literal('admin'), v.literal('member'))

async function hasMembers(ctx: QueryCtx) {
  return (await ctx.db.query('members').first()) !== null
}

async function setupTokenMatches(tokenHash: string | undefined) {
  const setupToken = process.env.TRIODITIS_SETUP_TOKEN
  if (!setupToken || !tokenHash) return false
  return constantTimeEqual(await sha256Hex(setupToken), tokenHash)
}

async function openInvitation(ctx: QueryCtx, email: string, tokenHash: string | undefined) {
  if (!tokenHash) return null
  const invitation = await ctx.db
    .query('invitations')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .unique()
  if (!invitation || invitation.acceptedAt || invitation.expiresAt < Date.now()) return null
  if (invitation.email !== email.trim().toLowerCase()) return null
  return invitation
}

/** Asked by Better Auth before it creates an account. */
export const mayCreateAccount = internalQuery({
  args: { email: v.string(), tokenHash: v.optional(v.string()) },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { email, tokenHash }) => {
    if (!(await hasMembers(ctx))) return { allowed: await setupTokenMatches(tokenHash) }
    return { allowed: (await openInvitation(ctx, email, tokenHash)) !== null }
  },
})

/**
 * Makes the new account a member. Checks again, in this transaction, so two sign-ups racing
 * for the setup token or one invitation can't both succeed: the loser's account is left
 * without membership and can do nothing.
 */
export const onAccountCreated = internalMutation({
  args: { userId: v.string(), email: v.string(), tokenHash: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { userId, email, tokenHash }) => {
    const now = Date.now()
    if (!(await hasMembers(ctx))) {
      if (!(await setupTokenMatches(tokenHash))) return null
      await ctx.db.insert('members', { userId, role: 'admin', createdAt: now })
      await audit(ctx, { kind: 'user', id: userId }, 'server.setup')
      return null
    }
    const invitation = await openInvitation(ctx, email, tokenHash)
    if (!invitation) return null
    await ctx.db.patch(invitation._id, { acceptedAt: now, acceptedBy: userId })
    await ctx.db.insert('members', { userId, role: invitation.role, createdAt: now })
    await audit(ctx, { kind: 'user', id: userId }, 'invitation.accept', invitation._id)
    return null
  },
})

/** The signed-in person's membership, or null if they aren't a member. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    try {
      const member = await requireMember(ctx)
      return { userId: member.userId, role: member.role, identityKid: member.identityKid ?? null }
    } catch {
      return null
    }
  },
})

/**
 * Records the person's identity public key, from their first device. It can't be replaced
 * here: a new identity key would orphan everything sealed to the old one, so that goes
 * through key recovery instead.
 */
export const setIdentityKey = mutation({
  args: { publicKey: v.string(), kid: v.string() },
  returns: v.null(),
  handler: async (ctx, { publicKey, kid }) => {
    const member = await requireMember(ctx)
    if (member.identityPublicKey && member.identityPublicKey !== publicKey) {
      throw new ConvexError('This account already has an identity key.')
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey) || !/^[A-Za-z0-9_-]{22}$/.test(kid)) {
      throw new ConvexError('That isn’t a valid public key.')
    }
    await ctx.db.patch(member._id, { identityPublicKey: publicKey, identityKid: kid })
    await audit(ctx, { kind: 'user', id: member.userId }, 'identity.set', kid)
    return null
  },
})

/**
 * Creates an invitation and returns its token, once. The admin shares the link; only the
 * token's hash is stored.
 */
export const invite = mutation({
  args: { email: v.string(), role },
  returns: v.object({ invitationId: v.id('invitations'), token: v.string() }),
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx)
    const email = args.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ConvexError('That isn’t an email address.')
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
    await ctx.db.delete(invitationId)
    await audit(ctx, { kind: 'user', id: admin.userId }, 'invitation.revoke', invitationId)
    return null
  },
})

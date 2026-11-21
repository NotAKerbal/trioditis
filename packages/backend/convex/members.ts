import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { components } from './_generated/api'
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server'
import { authComponent, currentSession, requireSessionIfGiven } from './auth'
import { requireAdmin } from './lib/access'
import { constantTimeEqual, randomToken, sha256Hex } from './lib/hash'
import { audit } from './lib/audit'
import { queueLoginCancel, queueLogout } from './lib/outbox'
import { issueReset } from './account'
import { deleteAllAuthRows } from './lib/authRows'
import { noteCleanup } from './lib/formerMembers'

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

/**
 * The invitations nobody has joined with yet (waiting or expired), newest first, a page at a
 * time, without their tokens. Joined ones are people now, and `members.list` shows them.
 */
export const invitations = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireAdmin(ctx)
    const result = await ctx.db
      .query('invitations')
      .order('desc')
      .filter((q) => q.eq(q.field('acceptedAt'), undefined))
      .paginate(paginationOpts)
    return { ...result, page: result.page.map(({ tokenHash: _tokenHash, ...invitation }) => invitation) }
  },
})

/** The server's members, oldest first, a page at a time, with each one's name and email. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const admin = await requireAdmin(ctx)
    const result = await ctx.db.query('members').paginate(paginationOpts)
    const page = await Promise.all(
      result.page.map(async (member) => {
        const user = await authComponent.getAnyUserById(ctx, member.userId)
        return {
          userId: member.userId,
          role: member.role,
          createdAt: member.createdAt,
          name: user?.name ?? null,
          email: user?.email ?? null,
          you: member.userId === admin.userId,
        }
      }),
    )
    return { ...result, page }
  },
})

/**
 * Makes a password reset link's token for a member who forgot their password, returned once. It
 * works for a day, once, and only together with the member's recovery key (account.resetPassword):
 * the admin can let them set a new password, but can't open their messages or sign in as them.
 * Not for the admin's own account, which changes its password in settings.
 */
export const issuePasswordReset = mutation({
  args: { userId: v.string(), sessionId: v.optional(v.string()) },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    if (args.userId === admin.userId) {
      throw new ConvexError('Change your own password in Settings → Keys and devices.')
    }
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .unique()
    if (!member) throw new ConvexError('That person isn’t a member of this server.')
    return await issueReset(ctx, member.userId, admin.userId)
  },
})

/**
 * The same, from the deployment's command line, for an admin locked out of their own account
 * (or a server's only admin): `npx convex run members:issuePasswordResetFor '{"email": "…"}'`.
 */
export const issuePasswordResetFor = internalMutation({
  args: { email: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { email }) => {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: normalizeEmail(email) }],
    })) as { _id: string } | null
    const member =
      user &&
      (await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', user._id))
        .unique())
    if (!member) throw new ConvexError('No member has that email.')
    return await issueReset(ctx, member.userId, 'cli')
  },
})

/** More than anyone has of each: removing a member clears them in one transaction. */
const REMOVE_LIMIT = 200

/**
 * Removes a member from the server. In this one transaction they lose their membership, so
 * every member function refuses them at once; their sessions, sign-in credential, passkeys and
 * account go, so the email can be invited again as a new account; their key backups and
 * challenges go; every agent connection they approved is revoked; and their network accounts
 * are logged out and logins in progress ended, through the bridge host as a disconnect does.
 * Their stored chats stay, sealed to a key nobody else holds.
 *
 * Some of that finishes later, and is fenced on membership meanwhile: an agent request approved
 * before the removal can still be exchanged for a token, but every MCP call checks its person is
 * still a member (mcp.ts); a send still waiting is never handed to a bridge host and is settled
 * instead (gateway.claimCommands); and the logouts are tracked in `removedMembers` until the
 * bridge host confirms each, queued again if one runs out of time (lib/commandOutcome.ts).
 *
 * An admin can't remove themselves (another admin can), and the last admin can't be removed,
 * so a server always has one.
 */
export const removeMember = mutation({
  args: { userId: v.string(), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    if (args.userId === admin.userId) throw new ConvexError('You can’t remove yourself. Ask another admin.')
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .unique()
    if (!member) throw new ConvexError('That person isn’t a member of this server.')
    if (member.role === 'admin') {
      const admins = (await ctx.db.query('members').take(1000)).filter((m) => m.role === 'admin')
      if (admins.length <= 1) throw new ConvexError('The server’s last admin can’t be removed.')
    }
    const userId = member.userId
    const user = await authComponent.getAnyUserById(ctx, userId)
    await ctx.db.delete(member._id)
    for (const table of ['keyBackups', 'keyChallenges', 'passwordResets'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(REMOVE_LIMIT)
      for (const row of rows) await ctx.db.delete(row._id)
    }
    const grants = await ctx.runQuery(components.mcp.grants.list, { userId })
    for (const grant of grants) await ctx.runMutation(components.mcp.grants.revoke, { userId, grantId: grant._id })
    const accounts = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(REMOVE_LIMIT)
    for (const account of accounts) await queueLogout(ctx, account)
    // Always: a login still under way can finish after this and report an account (lib/ingest.ts),
    // whose logout then belongs to this cleanup too.
    await noteCleanup(ctx, userId, { ...(user?.email ? { email: user.email } : {}), removedBy: admin.userId })
    const logins = await ctx.db
      .query('loginSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(REMOVE_LIMIT)
    for (const login of logins) {
      if (login.state !== 'pending' && login.state !== 'active') continue
      await queueLoginCancel(ctx, login)
      await ctx.db.patch(login._id, { state: 'cancelled', updatedAt: Date.now() })
    }
    for (const model of ['session', 'passkey', 'account'] as const) await deleteAllAuthRows(ctx, model, userId)
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'user', where: [{ field: '_id', value: userId }] },
    })
    await audit(ctx, { kind: 'user', id: admin.userId }, 'member.remove', userId)
    return null
  },
})

/** A removed member's network accounts not yet confirmed logged out. */
async function leftSignedIn(ctx: QueryCtx, userId: string) {
  const accounts = await ctx.db
    .query('networkAccounts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(REMOVE_LIMIT)
  return accounts.filter((account) => account.state !== 'LOGGED_OUT')
}

/**
 * Removed members whose network accounts are still being logged out, for Settings → Members: how
 * many are left, how many wait on the bridge host, and how many failed and can be tried again.
 */
export const removedCleanup = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.string(),
      email: v.union(v.null(), v.string()),
      removedAt: v.number(),
      accounts: v.number(),
      pending: v.number(),
      failed: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const rows = await ctx.db.query('removedMembers').order('desc').take(100)
    const out = []
    for (const row of rows) {
      const left = await leftSignedIn(ctx, row.userId)
      if (left.length === 0) continue
      out.push({
        userId: row.userId,
        email: row.email ?? null,
        removedAt: row.removedAt,
        accounts: left.length,
        pending: left.filter((account) => account.logoutPending).length,
        failed: left.filter((account) => !account.logoutPending).length,
      })
    }
    return out
  },
})

/**
 * Asks the bridge host again to log out a removed member's accounts that aren't logged out and
 * have no logout waiting. A cleanup with nothing left is forgotten.
 */
export const retryCleanup = mutation({
  args: { userId: v.string(), sessionId: v.optional(v.string()) },
  returns: v.object({ queued: v.number(), left: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    const record = await ctx.db
      .query('removedMembers')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .first()
    if (!record) throw new ConvexError('There’s nothing left to clean up for that person.')
    const left = await leftSignedIn(ctx, record.userId)
    if (left.length === 0) {
      await ctx.db.delete(record._id)
      return { queued: 0, left: 0 }
    }
    let queued = 0
    for (const account of left) if (await queueLogout(ctx, account)) queued++
    await audit(ctx, { kind: 'user', id: admin.userId }, 'member.cleanup.retry', record.userId)
    return { queued, left: left.length }
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

import { ConvexError, v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { authComponent, createAuth, requireSessionIfGiven, requireUserId } from './auth'
import { audit } from './lib/audit'
import { randomToken, sha256Hex } from './lib/hash'
import {
  backupsOf,
  checkReplacement,
  checkWrapped,
  consumeProof,
  credentialOf,
  issueChallenge,
  memberById,
  replaceBackup,
} from './keys'

// Changing the password, which is two things that must stay in step: the sign-in password
// (what `authPassword` derives; Better Auth keeps a hash of it) and the key backup wrapped by
// the password. This action is the only way to change either: Better Auth's own
// change-password route is turned off (auth.ts), and the two are written in one transaction.
// See docs/architecture/client-api.md, Changing the password.

const passwordParams = v.object({
  alg: v.literal('argon2id13'),
  salt: v.string(),
  opslimit: v.number(),
  memlimit: v.number(),
})

/** The sign-in credential's current hash, for the action to check the current password against. */
export const credential = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.null(), v.object({ accountId: v.string(), passwordHash: v.string() })),
  handler: async (ctx, { userId }) => await credentialOf(ctx, userId),
})

/**
 * Changes the password. The client derives `currentAuthPassword` and `newAuthPassword` with
 * `authPassword`, wraps the identity key with the new password (`newWrap`, fresh
 * `newPasswordParams()`), and proves it holds the key (`proof` from `keys.challenge`).
 *
 * In order: the proof (used up), revision and settings are checked; the current password is
 * checked against the sign-in credential and the new one hashed; then one transaction
 * replaces both the credential and the password backup, if neither changed meanwhile. Any
 * error leaves both as they were, so sign-in and unlocking always take the same password.
 */
export const changePassword = action({
  args: {
    currentAuthPassword: v.string(),
    newAuthPassword: v.string(),
    newWrap: v.object({ nonce: v.string(), ct: v.string(), params: passwordParams }),
    proof: v.string(),
    expectedRevision: v.number(),
    sessionId: v.optional(v.string()),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args): Promise<{ revision: number }> => {
    // With `sessionId`, the user is the one that check found, so a session ending just after
    // it is refused as `sessionChanged` (by the mutations below), not as signed out.
    const userId = (await requireSessionIfGiven(ctx, args.sessionId)) ?? (await requireUserId(ctx))
    const wrap = { ...args.newWrap, expectedRevision: args.expectedRevision, sessionId: args.sessionId }
    await ctx.runMutation(internal.keys.checkPasswordChange, { userId, proof: args.proof, ...wrap })
    const current = await ctx.runQuery(internal.account.credential, { userId })
    if (!current) throw new ConvexError('This account has no password to change.')
    // Better Auth's own hashing, as its sign-in checks it.
    const { password } = await createAuth(ctx).$context
    const { minPasswordLength, maxPasswordLength } = password.config
    const allowed = args.newAuthPassword.length >= minPasswordLength && args.newAuthPassword.length <= maxPasswordLength
    const matches = await password.verify({ hash: current.passwordHash, password: args.currentAuthPassword })
    if (!matches || !allowed) throw new ConvexError('Your current password is wrong, or the new one isn’t allowed.')
    return await ctx.runMutation(internal.keys.commitPasswordChange, {
      userId,
      previousHash: current.passwordHash,
      newHash: await password.hash(args.newAuthPassword),
      ...wrap,
    })
  },
})

// Resetting a forgotten password, with an admin's help and the person's recovery key. Sign-in
// takes a password derived from the person's own (`authPassword`), so nothing the server holds
// can sign them in without it; and their messages are sealed to a key only their password,
// recovery key or passkeys unwrap. So a reset needs both: a link an admin issues
// (`members.issuePasswordReset`), which lets the person set a new sign-in password, and their
// recovery key, which opens their key on the reset page so the password backup is wrapped again
// with the new password in the same transaction. Sign-in and unlocking keep taking the same
// password. See docs/architecture/client-api.md, Resetting a forgotten password.

/** How long a reset link works. */
const RESET_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Issues a reset link's token for a member, replacing any earlier one. Only the token's hash is
 * stored; the token is returned once.
 */
export async function issueReset(ctx: MutationCtx, userId: string, issuedBy: string) {
  const old = await ctx.db
    .query('passwordResets')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(20)
  for (const row of old) await ctx.db.delete(row._id)
  const token = randomToken()
  const expiresAt = Date.now() + RESET_TTL_MS
  await ctx.db.insert('passwordResets', { userId, tokenHash: await sha256Hex(token), issuedBy, expiresAt })
  await audit(ctx, { kind: 'user', id: issuedBy }, 'password.reset.issue', userId)
  return { token, expiresAt }
}

/** The reset `token` names, if it can still be used. */
async function openReset(ctx: QueryCtx, token: string) {
  const tokenHash = await sha256Hex(token)
  const reset = await ctx.db
    .query('passwordResets')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .unique()
  return reset && reset.expiresAt > Date.now() ? reset : null
}

async function requireReset(ctx: QueryCtx, token: string) {
  const reset = await openReset(ctx, token)
  if (!reset) throw new ConvexError('This reset link has expired or was already used. Ask your admin for a new one.')
  return reset
}

/** The revision of the person's current password backup (0 for none). */
function passwordRevision(backups: Doc<'keyBackups'>[], kid: string | undefined) {
  return backups
    .filter((row) => row.kind === 'password' && row.kid === kid)
    .reduce((n, row) => Math.max(n, row.revision), 0)
}

const newWrap = v.object({ nonce: v.string(), ct: v.string(), params: passwordParams })

/**
 * What the reset page needs, for a reset link's `token`: the account's email (sign-in derives
 * its password from it) and ID, and, if it has an identity key, that key and its recovery
 * backup, which the person's recovery key opens on the page. Null for a link that can't be used.
 * Nothing here opens without the recovery key; the token, 256 random bits, is what guards it.
 */
export const resetInfo = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      userId: v.string(),
      email: v.string(),
      key: v.union(
        v.null(),
        v.object({
          kid: v.string(),
          publicKey: v.string(),
          recovery: v.union(v.null(), v.object({ nonce: v.string(), ct: v.string() })),
          passwordParams: v.union(v.null(), passwordParams),
        }),
      ),
    }),
  ),
  handler: async (ctx, { token }) => {
    const reset = await openReset(ctx, token)
    if (!reset) return null
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', reset.userId))
      .unique()
    const user = await authComponent.getAnyUserById(ctx, reset.userId)
    if (!member || !user) return null
    if (!member.identityPublicKey || !member.identityKid) return { userId: reset.userId, email: user.email, key: null }
    const current = (await backupsOf(ctx, reset.userId)).filter((row) => row.kid === member.identityKid)
    const recovery = current.find((row) => row.kind === 'recovery')
    const password = current.find((row) => row.kind === 'password')
    return {
      userId: reset.userId,
      email: user.email,
      key: {
        kid: member.identityKid,
        publicKey: member.identityPublicKey,
        recovery: recovery ? { nonce: recovery.nonce, ct: recovery.ct } : null,
        passwordParams: password?.params ?? null,
      },
    }
  },
})

/** A challenge sealed to the account's key, for the reset page to prove it opened the key. */
export const resetChallenge = mutation({
  args: { token: v.string() },
  returns: v.object({ sealed: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { token }) => {
    const reset = await requireReset(ctx, token)
    const member = await memberById(ctx, reset.userId)
    if (!member.identityPublicKey) throw new ConvexError('This account has no key to prove.')
    return await issueChallenge(ctx, member.userId, member.identityPublicKey)
  },
})

/**
 * `resetPassword`, before anything else: the link, and for an account with a key, the new
 * password backup's shape and settings and the proof (used up here), so nothing is hashed for a
 * caller that couldn't open the key. Answers whose account it is and the password backup's
 * revision now, which the commit checks again.
 */
export const checkPasswordReset = internalMutation({
  args: { token: v.string(), newWrap: v.optional(newWrap), proof: v.optional(v.string()) },
  returns: v.object({ userId: v.string(), expectedRevision: v.union(v.null(), v.number()) }),
  handler: async (ctx, args) => {
    const reset = await requireReset(ctx, args.token)
    const member = await memberById(ctx, reset.userId)
    if (!member.identityPublicKey) {
      if (args.newWrap) throw new ConvexError('This account has no key to back up.')
      return { userId: member.userId, expectedRevision: null }
    }
    if (!args.newWrap || !args.proof) throw new ConvexError('Open your key with your recovery key first.')
    checkWrapped(args.newWrap)
    const expectedRevision = passwordRevision(await backupsOf(ctx, member.userId), member.identityKid)
    await checkReplacement(ctx, member, { kind: 'password', expectedRevision, params: args.newWrap.params })
    await consumeProof(ctx, member.userId, args.proof, member.identityPublicKey)
    return { userId: member.userId, expectedRevision }
  },
})

/**
 * `resetPassword`'s one write: the sign-in credential and the password backup change together,
 * the link is used up, and every session the account has ends, or nothing changes. It commits
 * only if the link still works and neither the credential nor the backup changed since the checks.
 */
export const commitPasswordReset = internalMutation({
  args: {
    token: v.string(),
    userId: v.string(),
    previousHash: v.string(),
    newHash: v.string(),
    expectedRevision: v.union(v.null(), v.number()),
    newWrap: v.optional(newWrap),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const reset = await requireReset(ctx, args.token)
    if (reset.userId !== args.userId)
      throw new ConvexError('This reset link has changed. Ask your admin for a new one.')
    const member = await memberById(ctx, args.userId)
    const credential = await credentialOf(ctx, member.userId)
    if (!credential || credential.passwordHash !== args.previousHash) {
      throw new ConvexError('Your password changed meanwhile. Open the reset link again.')
    }
    if (member.identityPublicKey) {
      if (!args.newWrap || args.expectedRevision === null) {
        throw new ConvexError('Open your key with your recovery key first.')
      }
      const replacing = await checkReplacement(ctx, member, {
        kind: 'password',
        expectedRevision: args.expectedRevision,
        params: args.newWrap.params,
      })
      await replaceBackup(ctx, member, replacing, { kind: 'password', ...args.newWrap })
    }
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'account',
        where: [{ field: '_id', value: credential.accountId }],
        update: { password: args.newHash, updatedAt: Date.now() },
      },
    })
    // Whoever had the old password is signed out everywhere.
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: 'session', where: [{ field: 'userId', value: member.userId }] },
      paginationOpts: { cursor: null, numItems: 200 },
    })
    await ctx.db.delete(reset._id)
    await audit(ctx, { kind: 'user', id: member.userId }, 'password.reset')
    return null
  },
})

/**
 * Resets a forgotten password with a reset link's `token`. The client opens the identity key with
 * the recovery key (`resetInfo`'s recovery backup), wraps it with the new password (`newWrap`,
 * fresh `newPasswordParams()`, never weaker than the backup it replaces), proves it holds the key
 * (`proof`, from `resetChallenge`), and derives `newAuthPassword` with `authPassword` and
 * `resetInfo`'s email. An account with no key yet sends neither `newWrap` nor `proof`. On success
 * every session ends; sign in with the new password.
 */
export const resetPassword = action({
  args: {
    token: v.string(),
    newAuthPassword: v.string(),
    newWrap: v.optional(newWrap),
    proof: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { userId, expectedRevision } = await ctx.runMutation(internal.account.checkPasswordReset, {
      token: args.token,
      newWrap: args.newWrap,
      proof: args.proof,
    })
    const current = await ctx.runQuery(internal.account.credential, { userId })
    if (!current) throw new ConvexError('This account has no password to reset.')
    const { password } = await createAuth(ctx).$context
    const { minPasswordLength, maxPasswordLength } = password.config
    if (args.newAuthPassword.length < minPasswordLength || args.newAuthPassword.length > maxPasswordLength) {
      throw new ConvexError('That new password isn’t allowed.')
    }
    await ctx.runMutation(internal.account.commitPasswordReset, {
      token: args.token,
      userId,
      previousHash: current.passwordHash,
      newHash: await password.hash(args.newAuthPassword),
      expectedRevision,
      newWrap: args.newWrap,
    })
    return null
  },
})

import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { action, internalQuery } from './_generated/server'
import { createAuth, requireUserId } from './auth'
import { credentialOf } from './keys'

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
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args): Promise<{ revision: number }> => {
    const userId = await requireUserId(ctx)
    const wrap = { ...args.newWrap, expectedRevision: args.expectedRevision }
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

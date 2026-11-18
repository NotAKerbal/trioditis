import { APIError } from 'better-auth/api'
import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { action } from './_generated/server'
import { authComponent, createAuth, requireUserId } from './auth'

// Changing the password, which is two things that must stay in step: the sign-in password
// (what `authPassword` derives; Better Auth keeps a hash of it) and the key backup wrapped by
// the password. One action does both. See docs/architecture/client-api.md, Changing the
// password.

const passwordParams = v.object({
  alg: v.literal('argon2id13'),
  salt: v.string(),
  opslimit: v.number(),
  memlimit: v.number(),
})

/**
 * Changes the password. The client derives `currentAuthPassword` and `newAuthPassword` with
 * `authPassword`, wraps the identity key with the new password (`newWrap`, fresh
 * `newPasswordParams()`), and proves it holds the key (`proof` from `keys.challenge`).
 *
 * In order: the proof, revision and settings are checked; the sign-in password changes; the new
 * wrap is stored. If storing fails, the sign-in password is changed back. If that fails too,
 * the error says so: the person then signs in with the new password, but the old one still
 * unlocks their key until they change it again.
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
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx)
    const change = (currentPassword: string, newPassword: string) =>
      auth.api.changePassword({ body: { currentPassword, newPassword }, headers })
    try {
      await change(args.currentAuthPassword, args.newAuthPassword)
    } catch (error) {
      if (error instanceof APIError)
        throw new ConvexError('Your current password is wrong, or the new one isn’t allowed.')
      throw error
    }
    try {
      return await ctx.runMutation(internal.keys.storePasswordWrap, { userId, ...wrap })
    } catch {
      try {
        await change(args.newAuthPassword, args.currentAuthPassword)
      } catch {
        throw new ConvexError(
          'Your password changed, but your key backup didn’t: your old password still unlocks your key. Change your password again to fix it.',
        )
      }
      throw new ConvexError('Your password wasn’t changed. Try again.')
    }
  },
})

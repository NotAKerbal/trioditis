import { APIError } from 'better-auth/api'
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal'
import { passkey } from '@better-auth/passkey'
import { createClient } from '@convex-dev/better-auth'
import type { AuthFunctions, GenericCtx } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { ConvexError } from 'convex/values'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import { query } from './_generated/server'
import authConfig from './auth.config'
import authSchema from './betterAuth/schema'
import { sha256Hex } from './lib/hash'

// The URL the app is served from. Set per deployment: `npx convex env set SITE_URL ...`
const siteUrl = process.env.SITE_URL!

// Typed here so `authComponent`'s type doesn't depend on this file's own exports.
const authFunctions: AuthFunctions = internal.auth

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
})

// Run by the component inside its own writes.
export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi()

/**
 * The request header that carries an invitation's token, or the server's setup token, during
 * sign-up. A server has no open sign-up: every account starts from an invitation, and the
 * first (the admin) from the setup token the installer prints.
 */
export const INVITE_HEADER = 'x-trioditis-invite'

/**
 * Better Auth's settings. Kept apart from `createAuth` so the component's adapter can read
 * them without starting Better Auth.
 */
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      // Trioditis servers don't send email yet; invitations are links the admin shares.
      requireEmailVerification: false,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
    },
    databaseHooks: {
      user: {
        create: {
          // Runs for every new account, however it is created.
          before: async (user, endpoint) => {
            const token = endpoint?.headers?.get(INVITE_HEADER)
            const decision = await ctx.runQuery(internal.members.mayCreateAccount, {
              email: user.email,
              tokenHash: token ? await sha256Hex(token) : undefined,
            })
            if (!decision.allowed) {
              throw new APIError('FORBIDDEN', {
                code: 'INVITE_REQUIRED',
                message: 'An invitation is required to create an account on this server.',
              })
            }
          },
          // Sign-up runs in an HTTP action, which can run mutations; a query context never
          // creates accounts.
          after: async (user, endpoint) => {
            if (!('runMutation' in ctx)) return
            const token = endpoint?.headers?.get(INVITE_HEADER)
            await ctx.runMutation(internal.members.onAccountCreated, {
              userId: user.id,
              email: user.email,
              tokenHash: token ? await sha256Hex(token) : undefined,
            })
          },
        },
      },
    },
    plugins: [
      passkey({
        rpName: 'Trioditis',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      }),
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx))
}

/**
 * The signed-in user's ID, or null. Every function that touches a person's data gets them
 * here (or from `requireUserId`), so this one place decides who is signed in.
 *
 * A Convex token works for several minutes after it is issued, so the user counts as signed
 * in only while the Better Auth session it names is still there, theirs and unexpired.
 * Signing out deletes that row, and live queries run again without the user.
 */
export async function currentUserId(ctx: GenericCtx<DataModel>): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity()
  const sessionId = identity?.sessionId
  if (!identity || typeof sessionId !== 'string') return null
  const session = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'session',
    where: [
      { field: '_id', value: sessionId },
      { field: 'userId', value: identity.subject },
      { field: 'expiresAt', operator: 'gt', value: Date.now() },
    ],
  })
  return session ? identity.subject : null
}

export async function requireUserId(ctx: GenericCtx<DataModel>): Promise<string> {
  const userId = await currentUserId(ctx)
  if (!userId) throw new ConvexError('You’re signed out. Sign in again to continue.')
  return userId
}

/** The signed-in user, or null. */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx)
    if (!userId) return null
    const user = await authComponent.getAnyUserById(ctx, userId)
    if (!user) return null
    return { id: user._id, name: user.name, email: user.email }
  },
})

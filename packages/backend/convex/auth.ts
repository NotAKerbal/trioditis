import { APIError, createAuthEndpoint } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth'
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal'
import { passkey } from '@better-auth/passkey'
import { createClient } from '@convex-dev/better-auth'
import type { AuthFunctions, GenericCtx } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { ConvexError, v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import { internalMutation, query } from './_generated/server'
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

/** Longer than any session token Better Auth issues (32 characters). */
const MAX_SESSION_TOKEN_LENGTH = 256

/**
 * `POST /api/auth/end-session` with `{ token }`: ends exactly the session with that token,
 * whoever the request's cookie signs in. Holding the token is the authority, as it is for the
 * cookie that carries it.
 *
 * The app ends a session this way when another tab may have signed in as someone else since
 * it read the token: Better Auth's /revoke-session acts only on the cookie's own user's
 * sessions and answers `status: true` even when it deleted nothing, and /sign-out ends the
 * cookie's session, which may no longer be the one meant.
 *
 * It answers 200 with `{ result: 'ended' }` when it deleted the session, or
 * `{ result: 'absent' }` when there was no session with that token; anything else is an
 * error and nothing was changed, or it couldn't tell. It sets no cookie, not even an expired
 * one: a late answer could otherwise clear a sign-in made meanwhile in another tab.
 */
const endSession = (ctx: GenericCtx<DataModel>) =>
  ({
    id: 'trioditis-session',
    endpoints: {
      endSession: createAuthEndpoint('/end-session', { method: 'POST' }, async (endpoint) => {
        // Origin is checked whether or not a cookie came with the request, which Better Auth's
        // own check skips when there is none.
        const origin = endpoint.request?.headers.get('origin')
        if (!origin || origin === 'null' || !endpoint.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
          throw new APIError('FORBIDDEN', { message: 'Invalid origin' })
        }
        const token: unknown = (endpoint.body as { token?: unknown } | undefined)?.token
        if (typeof token !== 'string' || token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH) {
          throw new APIError('BAD_REQUEST', { message: 'A session token is required.' })
        }
        if (!('runMutation' in ctx)) throw new APIError('INTERNAL_SERVER_ERROR')
        const result = await ctx.runMutation(internal.auth.endSessionByToken, { token })
        return endpoint.json({ result })
      }),
    },
    rateLimit: [{ pathMatcher: (path) => path === '/end-session', window: 10, max: 10 }],
  }) satisfies BetterAuthPlugin

/**
 * Deletes the session with `token`, if there is one, in one transaction: a session that is
 * found is the one deleted, so `ended` always means this call removed it.
 */
export const endSessionByToken = internalMutation({
  args: { token: v.string() },
  returns: v.union(v.literal('ended'), v.literal('absent')),
  handler: async (ctx, { token }) => {
    const session = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'session',
      where: [{ field: 'token', value: token }],
    })) as { _id: string } | null
    if (!session) return 'absent'
    await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'session', where: [{ field: '_id', value: session._id }] },
    })
    return 'ended'
  },
})

/**
 * Better Auth's settings. Kept apart from `createAuth` so the component's adapter can read
 * them without starting Better Auth.
 */
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    // The password changes only through `account.changePassword`, which changes the key
    // backup with it; a change here would leave sign-in and unlocking on different
    // passwords. Resets need email, which servers don't send yet, and changing the email
    // would change what `authPassword` derives.
    disabledPaths: [
      '/change-password',
      '/set-password',
      '/request-password-reset',
      '/forget-password',
      '/reset-password',
      '/change-email',
    ],
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
          // Runs for every new account, however it is created. Sign-up runs in an HTTP
          // action, which can run mutations; nothing else creates accounts.
          before: async (user, endpoint) => {
            const token = endpoint?.headers?.get(INVITE_HEADER)
            const decision =
              'runMutation' in ctx
                ? await ctx.runMutation(internal.members.reserveAdmission, {
                    email: user.email,
                    tokenHash: token ? await sha256Hex(token) : undefined,
                  })
                : { allowed: false }
            if (!decision.allowed) {
              throw new APIError('FORBIDDEN', {
                code: 'INVITE_REQUIRED',
                message: 'An invitation is required to create an account on this server.',
              })
            }
          },
          after: async (user, endpoint) => {
            if (!('runMutation' in ctx)) return
            const token = endpoint?.headers?.get(INVITE_HEADER)
            const { admitted } = await ctx.runMutation(internal.members.onAccountCreated, {
              userId: user.id,
              email: user.email,
              tokenHash: token ? await sha256Hex(token) : undefined,
            })
            if (admitted) return
            // What admitted it in `before` no longer holds (which the reservation makes
            // unlikely). Remove the account rather than leave one that can do nothing and
            // keeps its email taken, and fail the sign-up.
            // Better Auth runs this hook after it has made the account's session, so that
            // goes too.
            for (const model of ['session', 'account'] as const) {
              await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
                input: { model, where: [{ field: 'userId', value: user.id }] },
                paginationOpts: { cursor: null, numItems: 100 },
              })
            }
            await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
              input: { model: 'user', where: [{ field: '_id', value: user.id }] },
            })
            throw new APIError('FORBIDDEN', {
              code: 'INVITE_REQUIRED',
              message: 'An invitation is required to create an account on this server.',
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
      endSession(ctx),
    ],
  } satisfies BetterAuthOptions
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx))
}

/**
 * The signed-in user and the Better Auth session they're signed in with, or null. Every
 * function that touches a person's data gets them here (or from `currentUserId` and
 * `requireUserId`), so this one place decides who is signed in.
 *
 * A Convex token works for several minutes after it is issued, so the user counts as signed
 * in only while the Better Auth session it names is still there, theirs and unexpired.
 * Signing out deletes that row, and live queries run again without the user.
 */
export async function currentSession(
  ctx: GenericCtx<DataModel>,
): Promise<{ userId: string; sessionId: string } | null> {
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
  return session ? { userId: identity.subject, sessionId } : null
}

/** The signed-in user's ID, or null. */
export async function currentUserId(ctx: GenericCtx<DataModel>): Promise<string | null> {
  return (await currentSession(ctx))?.userId ?? null
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

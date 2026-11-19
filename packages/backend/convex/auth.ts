import { APIError, createAuthEndpoint, createAuthMiddleware, getIP } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth'
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal'
import { passkey } from '@better-auth/passkey'
import { createClient } from '@convex-dev/better-auth'
import type { AuthFunctions, GenericCtx } from '@convex-dev/better-auth'
import { convex } from '@convex-dev/better-auth/plugins'
import { ConvexError, v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import { internalMutation, query, type ActionCtx } from './_generated/server'
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
/**
 * The header a page sends its session in (`members.me`'s `sessionId`) on Better Auth routes
 * that take no body of ours, as `sessionId` binds Convex calls.
 */
export const SESSION_HEADER = 'x-trioditis-session-id'

/** Better Auth's passkey registration: the options that hold the challenge, and the answer. */
const PASSKEY_REGISTRATION_PATHS = ['/passkey/generate-register-options', '/passkey/verify-registration']

/**
 * Adding a passkey, bound to the page's session like the key writes: a page another tab's
 * sign-in has switched would otherwise ask for options, and so a challenge, for the other
 * account. Both steps are refused (409, code `sessionChanged`) before anything is written when
 * the header names another session than the cookie's, or a bearer token comes as well. The
 * passkey plugin itself already refuses an answer from another account than the one its
 * challenge was made for. Without the header nothing is checked, as before.
 */
const passkeySessionBinding = {
  id: 'trioditis-passkey-session',
  hooks: {
    before: [
      {
        matcher: (context) => PASSKEY_REGISTRATION_PATHS.includes(context.path ?? ''),
        handler: createAuthMiddleware(async (context) => {
          const expected = context.headers?.get(SESSION_HEADER)
          if (expected === null || expected === undefined) return
          const refuse = () => {
            throw new APIError('CONFLICT', { code: SESSION_CHANGED.code, message: SESSION_CHANGED.message })
          }
          // A page signs in with its cookie. A bearer token as well would make Better Auth act
          // on that session instead, after this check, so it isn't taken here.
          if (context.headers?.get('authorization')) refuse()
          // The cookie's session, read as it is: looking it up the usual way would also extend
          // or end it, which a refused request mustn't do to someone else's session.
          const token = await context.getSignedCookie(
            context.context.authCookies.sessionToken.name,
            context.context.secret,
          )
          const found = token ? await context.context.internalAdapter.findSession(token) : null
          if (found?.session.id !== expected) refuse()
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

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
 * The request header that carries the client's address, set by the proxy in front of the
 * backend and by nothing else, replacing any a client sent (the self-hosted bundle's Caddy,
 * once the install bundle sets it). Without it the per-address limits are off. Better Auth reads the address from this header only, since a
 * client can send any of the usual ones (X-Forwarded-For and the like) itself.
 */
export const CLIENT_IP_HEADER = 'x-trioditis-client-ip'

/** Per client address, on the routes that check a password, a passkey or a session token. */
const STRICT_LIMIT = { window: 60, max: 10 }
/** Per client address, on every other auth route. */
const DEFAULT_LIMIT = { window: 60, max: 300 }
/**
 * Per account, by email, on password sign-in and on sign-up, whatever the address. It refills
 * at 30 a minute, three times the strict limit per address, so guessing at an account stays
 * bounded even from many addresses. The cost: requests from three or more addresses together
 * can take each token as it refills, and a real sign-in may then lose the race for it. A
 * passkey sign-in isn't counted here, so it still works for someone kept out this way.
 */
const ACCOUNT_LIMIT = { window: 60, max: 30 }

const STRICT_PATHS = [
  '/sign-in/email',
  // Also how invitations and the setup token are redeemed.
  '/sign-up/email',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/end-session',
]
const ACCOUNT_PATHS = ['/sign-in/email', '/sign-up/email']

const ipOptions = { advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } } } satisfies BetterAuthOptions

/**
 * A rule that applies only when the proxy said who the client is. Without the header (in
 * development, on previews, or behind a proxy that doesn't set it) every request would share
 * one bucket, and anyone could keep everyone out by filling it; then only the per-account
 * limit applies.
 */
const perClient = (rule: { window: number; max: number }) => (request: Request) =>
  request.headers.has(CLIENT_IP_HEADER) && getIP(request, ipOptions) && isRouted(request) ? rule : false

/** Where Better Auth serves its routes: its default, which `registerRoutes` uses too. */
const AUTH_BASE_PATH = '/api/auth'

/**
 * Better Auth's routes, as patterns (a `:name` segment matches any one segment), filled in by
 * `createAuth`. Until then every path counts as one.
 */
let authRoutes: { template: string; pattern: RegExp; methods: string[] | null }[] | null = null

/** The route `path` is a request to, as Better Auth declares it (`/callback/:id`), or null. */
function authRouteOf(path: string) {
  if (!authRoutes) return path
  return authRoutes.find((route) => route.pattern.test(path))?.template ?? null
}

export function routePattern(path: string) {
  // As better-call's router: `:name` is one segment, a final `*` one segment or none, and
  // `**` any number of segments, none included. Empty segments (`//`, or a trailing `/` the
  // route doesn't declare) match nothing; one it does declare must be there.
  const segments = path.split('/').filter((segment) => segment !== '')
  const pattern = segments
    .map((segment, index, all) => {
      if (segment === '**') return '(?:/[^/]+)*'
      if (segment === '*') return index === all.length - 1 ? '(?:/[^/]+)?' : '/[^/]+'
      if (segment.startsWith(':')) return '/[^/]+'
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    })
    .join('')
  return new RegExp(`^${pattern}${path.length > 1 && path.endsWith('/') ? '/' : ''}$`)
}

/**
 * Whether Better Auth would serve `request`: its exact path (a trailing slash is turned away)
 * with a method the route takes. Better Auth counts a request before it looks, so one it then
 * answers 404 would otherwise use up the route's bucket.
 */
function isRouted(request: Request) {
  if (!authRoutes) return true
  const path = routedPath(request.url, authBase ?? authBaseUrl())
  if (path === null) return false
  // As better-call's router: an endpoint without a method takes every one; otherwise only those
  // it names (`'*'` among them only as itself).
  return authRoutes.some(
    (route) => route.pattern.test(path) && (route.methods === null || route.methods.includes(request.method)),
  )
}

/**
 * The path of `url` under Better Auth's base, exactly as its router sees it (a trailing slash
 * kept, so it matches nothing), or null if it isn't under the base.
 */
export function routedPath(url: string, baseURL: string) {
  const base = new URL(baseURL).pathname.replace(/\/+$/, '')
  const raw = new URL(url).pathname
  return raw.startsWith(`${base}/`) ? raw.slice(base.length) : null
}

/** Better Auth's own base URL, as its context has it, set on the first request. */
let authBase: string | null = null

/** Better Auth's base URL, however `SITE_URL` ends. */
export function authBaseUrl(site = siteUrl) {
  return new URL(AUTH_BASE_PATH, site).toString()
}

/** The path under Better Auth's base path, as its rate limiter matches it. */
function authPath(request: Request, baseURL: string) {
  const base = new URL(baseURL).pathname.replace(/\/+$/, '')
  const path = new URL(request.url).pathname.replace(/\/+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path
}

/** The email in a JSON request body, as Better Auth compares it, or null. */
async function requestEmail(request: Request) {
  try {
    const email: unknown = ((await request.clone().json()) as { email?: unknown } | null)?.email
    return typeof email === 'string' ? email.trim().toLowerCase() : null
  } catch {
    return null
  }
}

/** Whether the request says its body is JSON, the only form the per-account limit can read. */
function isJson(request: Request) {
  return (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json'
}

/**
 * Takes a token, logging a failure clearly before passing it on. A failure fails the auth
 * request (a 500) rather than letting it past the limit: a broken limiter keeps people from
 * signing in, never turns the limits off. The key isn't logged: it can hold an address.
 */
async function consumeOrLog(
  ctx: Pick<ActionCtx, 'runMutation'>,
  path: string,
  args: { key: string; max: number; window: number },
) {
  try {
    return await ctx.runMutation(internal.rateLimits.consume, args)
  } catch (error) {
    console.error(`[rate limit] Couldn't count a request to ${path}, so it was refused:`, error)
    throw error
  }
}

/** Better Auth's 429, with the wait in both its header and HTTP's. */
function tooManyRequests(retryAfter: number) {
  return Response.json(
    { message: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': `${retryAfter}`, 'X-Retry-After': `${retryAfter}` } },
  )
}

/** Better Auth's own 429 gives the wait only in X-Retry-After. */
function withRetryAfter(response: Response) {
  const retryAfter = response.headers.get('x-retry-after')
  if (response.status !== 429 || !retryAfter || response.headers.has('retry-after')) return response
  const headers = new Headers(response.headers)
  headers.set('retry-after', retryAfter)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * The per-account limit. It runs after Better Auth's per-address one, so requests that one
 * refused don't use up the account's bucket.
 */
const accountRateLimit = (ctx: GenericCtx<DataModel>) =>
  ({
    id: 'trioditis-account-rate-limit',
    onRequest: async (request, auth) => {
      const path = authPath(request, auth.baseURL)
      if (!ACCOUNT_PATHS.includes(path) || !isRouted(request) || !('runMutation' in ctx)) return
      // Better Auth also takes these as forms, which this couldn't count: the app sends JSON,
      // so anything else is refused rather than let past the limit.
      if (!isJson(request)) {
        return { response: Response.json({ message: 'Send this as JSON.' }, { status: 415 }) }
      }
      // Without an email Better Auth refuses the request itself, before any password check.
      const email = await requestEmail(request)
      if (!email) return
      const { allowed, retryAfter } = await consumeOrLog(ctx, path, {
        key: await sha256Hex(`account|${path}|${email}`),
        ...ACCOUNT_LIMIT,
      })
      if (!allowed) return { response: tooManyRequests(retryAfter ?? ACCOUNT_LIMIT.window) }
    },
  }) satisfies BetterAuthPlugin

/**
 * Better Auth's settings. Kept apart from `createAuth` so the component's adapter can read
 * them without starting Better Auth.
 */
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    advanced: ipOptions.advanced,
    logger: {
      log: (level, message, ...args) => {
        // Said for every request without the client address header, since each HTTP action
        // starts afresh, and untrue here: `perClient` turns the per-address limit off then
        // rather than share one bucket.
        if (message.startsWith('Rate limiting could not determine a client IP')) return
        if (level === 'error') console.error(`[Better Auth]: ${message}`, ...args)
        else if (level === 'warn') console.warn(`[Better Auth]: ${message}`, ...args)
        else console.log(`[Better Auth]: ${message}`, ...args)
      },
    },
    // On whatever NODE_ENV is, and kept in Convex (rateLimits.ts): Better Auth's default store
    // is memory, which a Convex HTTP action starts without. Each request takes a token in one
    // mutation, so concurrent ones can't all pass. Keys are hashed, so no address is stored.
    rateLimit: {
      enabled: true,
      ...DEFAULT_LIMIT,
      // The first match wins, so the catch-all comes last. These replace Better Auth's own
      // rules for sign-in and sign-up.
      customRules: {
        ...Object.fromEntries(STRICT_PATHS.map((path) => [path, perClient(STRICT_LIMIT)])),
        // Only requests Better Auth serves (`perClient` checks): a request to any other path
        // would otherwise leave a bucket behind for each path made up.
        '/**': perClient(DEFAULT_LIMIT),
      },
      customStorage: {
        consume: async (key, rule) => {
          // Only HTTP requests are rate limited, and HTTP actions can run mutations. In a
          // query nothing can be written, so nothing could be counted either.
          if (!('runMutation' in ctx)) return { allowed: true, retryAfter: null }
          // Better Auth's key is `<address>|<path>`. Counted, and logged, by the route the path
          // is to, so `/callback/a` and `/callback/b` share one bucket and a path's own
          // segments (which a client chooses) never reach the log.
          const split = key.indexOf('|')
          const address = key.slice(0, split)
          const route = authRouteOf(key.slice(split + 1)) ?? 'an unknown route'
          return await consumeOrLog(ctx, route, { key: await sha256Hex(`client|${address}|${route}`), ...rule })
        },
      },
    },
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
      // Checks a signed-in session's password, which only account.changePassword (rate
      // limited) should do.
      '/verify-password',
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
      accountRateLimit(ctx),
      passkeySessionBinding,
    ],
  } satisfies BetterAuthOptions
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const auth = betterAuth(createAuthOptions(ctx))
  // Only routes served over HTTP: Better Auth leaves out those marked server-only.
  type Endpoint = {
    path?: unknown
    options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } }
  }
  authRoutes ??= Object.values(auth.api as Record<string, Endpoint>)
    .filter((endpoint) => typeof endpoint.path === 'string' && !endpoint.options?.metadata?.SERVER_ONLY)
    .map((endpoint) => ({
      template: endpoint.path as string,
      pattern: routePattern(endpoint.path as string),
      methods: endpoint.options?.method === undefined ? null : [endpoint.options.method].flat(),
    }))
  return {
    ...auth,
    handler: async (request: Request) => {
      // The base Better Auth routes under, from its own context, so the limits match the router
      // whatever path SITE_URL has.
      authBase ??= (await auth.$context).baseURL
      return withRetryAfter(await auth.handler(request))
    },
  }
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

/**
 * What a call bound to a session is refused with when it runs as another one. `code` is for
 * the app to act on; `message` is for the person.
 */
export const SESSION_CHANGED = {
  code: 'sessionChanged',
  message: 'This page’s session has changed. Reload the page.',
} as const

/**
 * Refuses the call, before it writes anything, unless it runs as the Better Auth session
 * `sessionId`. A page passes the session it opened with (`members.me`'s `sessionId`), because
 * the Convex client it shares with other tabs can switch to another account's token while the
 * page still shows the first: without this, a write the page meant for one account would land
 * on the other. With `userId`, the session must also be that user's. Returns the session's
 * user when `sessionId` is given; omitted, nothing is checked.
 */
export async function requireSessionIfGiven(
  ctx: GenericCtx<DataModel>,
  sessionId: string | undefined,
  userId?: string,
) {
  if (sessionId === undefined) return
  const session = await currentSession(ctx)
  if (session?.sessionId !== sessionId || (userId !== undefined && session.userId !== userId)) {
    throw new ConvexError(SESSION_CHANGED)
  }
  return session.userId
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

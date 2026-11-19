import { passkeyClient } from '@better-auth/passkey/client'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { authPassword, ready } from '@trioditis/crypto'
import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth on the app's own origin (no baseURL): /api/auth is proxied to the Convex site, by
 * the dev server here and by Caddy in the self-hosted bundle, so cookies and passkeys belong to
 * this origin. See docs/architecture/client-api.md, Setup on the client.
 */
export const authClient = createAuthClient({
  plugins: [convexClient(), passkeyClient()],
  fetchOptions: {
    // An answer over a rate limit says how long to wait (Retry-After, in seconds): kept for the
    // screen that made the request to say so (tooManyAttempts in lib/errors.ts).
    onError: ({ response }) => {
      const seconds = Number(response.headers.get('Retry-After'))
      retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
    },
    // Each Convex token the app is given (the provider asks through this client), kept by the
    // session it names, so a later read can use the page's own without asking again.
    onSuccess: ({ request, data }) => {
      const token = (data as { token?: unknown } | null)?.token
      if (!String(request.url).includes('/convex/token') || typeof token !== 'string') return
      const session = tokenSession(token)
      if (session) convexTokens.set(session, token)
    },
  },
})

let retryAfter: number | null = null
const convexTokens = new Map<string, string>()

/** The Better Auth session a Convex token names (its `sessionId` claim), if it can be read. */
export function tokenSession(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(payload)) as { sessionId?: unknown }
    return typeof claims.sessionId === 'string' ? claims.sessionId : null
  } catch {
    return null
  }
}

/**
 * The latest Convex token this page was given for `sessionId`, if any: for asking Convex
 * directly as that session, with no request to the auth server (which can set cookies).
 */
export const convexTokenFor = (sessionId: string) => convexTokens.get(sessionId) ?? null

/** How long the last refused auth request said to wait, in seconds, if it said. */
export const lastRetryAfter = () => retryAfter

/** The header that carries an invitation's token, or the setup token, on sign-up. Matches the backend. */
export const INVITE_HEADER = 'x-trioditis-invite'

/**
 * What the app sends Better Auth instead of the password: an Argon2id derivation salted by the
 * email, so the server never sees the password itself (client-api.md, Passwords).
 */
export async function derivedAuthPassword(password: string, email: string): Promise<string> {
  await ready()
  // Let the browser paint the busy state before the derivation blocks the main thread.
  await new Promise((resolve) => setTimeout(resolve, 30))
  return authPassword(password, email)
}

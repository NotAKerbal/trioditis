import { passkeyClient } from '@better-auth/passkey/client'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth, reached on this app's own origin. The dev server (and, in production, whatever
 * serves the app) forwards /api/auth to the Convex deployment, so the session cookie is
 * first-party and never crosses origins.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [convexClient(), passkeyClient()],
})

/** The header that carries an invitation's token, or the setup token, on sign-up. Matches the backend. */
export const INVITE_HEADER = 'x-trioditis-invite'

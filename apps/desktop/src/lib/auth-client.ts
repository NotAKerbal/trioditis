import { passkeyClient } from '@better-auth/passkey/client'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { config } from './config.ts'

/** Better Auth. `convexSiteUrl` is the app's own origin wherever /api/auth is proxied, so the cookie is first-party. */
export const authClient = createAuthClient({
  baseURL: config.convexSiteUrl,
  plugins: [convexClient(), passkeyClient()],
})

/** The header that carries an invitation's token, or the setup token, on sign-up. Matches the backend. */
export const INVITE_HEADER = 'x-trioditis-invite'

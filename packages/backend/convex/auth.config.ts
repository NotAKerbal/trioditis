import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config'
import type { AuthConfig } from 'convex/server'

// Convex checks tokens against Better Auth's JWKS, fetched from this deployment's site URL.
// It reads no optional environment variable: Convex refuses to deploy an auth config that
// references one that isn't set. (A static key set, for a server that can't reach its own
// public address, is a Phase 1 follow-up; the self-hosted bundle routes that address to
// itself instead.)
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig

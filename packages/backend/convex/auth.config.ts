import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config'
import type { AuthConfig } from 'convex/server'

// With JWKS set (a static key set, from `npx convex run auth:rotateKeys`), Convex checks
// tokens against it directly instead of fetching Better Auth's JWKS from this deployment's
// public URL, which fails on a server behind NAT that can't reach its own public address.
export default {
  providers: [getAuthConfigProvider(process.env.JWKS ? { jwks: process.env.JWKS } : undefined)],
} satisfies AuthConfig

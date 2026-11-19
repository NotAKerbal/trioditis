// Where the backend lives. Set at build time (VITE_CONVEX_URL, VITE_CONVEX_SITE_URL,
// VITE_TRIODITIS_ENVIRONMENT); the self-hosted bundle isn't built per server, so without them
// the app reads /config.json, which the server writes. See docs/architecture/client-api.md.

export interface AppConfig {
  convexUrl: string
  /** The Convex deployment's HTTP actions. Auth doesn't use it directly: /api/auth is proxied on the app's own origin. */
  convexSiteUrl: string
  environment: string
}

async function loadConfig(): Promise<AppConfig> {
  const env = import.meta.env
  if (env.VITE_CONVEX_URL) {
    return {
      convexUrl: env.VITE_CONVEX_URL,
      convexSiteUrl: env.VITE_CONVEX_SITE_URL || window.location.origin,
      environment: env.VITE_TRIODITIS_ENVIRONMENT || 'development',
    }
  }
  const response = await fetch('/config.json', { cache: 'no-store' })
  if (!response.ok)
    throw new Error('This server hasn’t published /config.json, so the app doesn’t know where its backend is.')
  const json = (await response.json()) as Partial<AppConfig>
  if (!json.convexUrl) throw new Error('/config.json has no convexUrl.')
  return {
    convexUrl: json.convexUrl,
    convexSiteUrl: json.convexSiteUrl || window.location.origin,
    environment: json.environment || 'production',
  }
}

export const config = await loadConfig()

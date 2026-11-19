// Which server the desktop app talks to, as checks with no Electron in them, so they can be
// tested in Node. The app loads that server's own web app: sign-in, cookies and passkeys stay
// first-party on its origin, and the app is always the version the server runs.

export type ServerAddress = { origin: string } | { error: string }

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.test(hostname)
}

/**
 * What the person typed, as a server origin. A bare host gets https. Plain http is only for
 * this machine: anywhere else the password would cross the network in the clear. A path is
 * dropped, since the web app is always served from the origin's root.
 */
export function normalizeServer(input: string): ServerAddress {
  const typed = input.trim()
  if (!typed) return { error: 'Enter your server’s address.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { error: 'That isn’t a web address.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'The address should start with https://.' }
  if (url.username || url.password) return { error: 'Leave the user name and password out of the address.' }
  if (url.protocol === 'http:' && !isLoopback(url.hostname))
    return { error: 'Use https:// for a server on another machine. Plain http is only for this one.' }
  return { origin: url.origin }
}

/** Links that may be handed to the system's browser or mail app. Nothing else leaves the app. */
export function isExternalAllowed(target: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(target).protocol)
  } catch {
    return false
  }
}

export function sameOrigin(target: string, origin: string): boolean {
  try {
    return new URL(target).origin === origin
  } catch {
    return false
  }
}

/** The marker the web app's index.html carries, for a server that doesn't publish /config.json. */
const MARKER = /<meta\s+name=["']application-name["']\s+content=["']Trioditis["']/i

/**
 * Whether what a server answered is Trioditis: its /config.json (the self-hosted bundle
 * publishes one) names a Convex deployment, or its page carries the app's marker (a dev server
 * or a Vercel preview, whose config is built in).
 */
export function looksLikeTrioditis(answer: { config?: unknown; html?: string }): boolean {
  const config = answer.config as { convexUrl?: unknown } | null | undefined
  if (config && typeof config === 'object' && typeof config.convexUrl === 'string' && config.convexUrl) return true
  return !!answer.html && MARKER.test(answer.html)
}

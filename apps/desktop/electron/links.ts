import { isLoopback, normalizeServer } from './server.ts'

// Links the system hands the desktop app: `trioditis://<server>/invite?email=…#token=…`, the
// invitation a server's Settings → Members makes with `trioditis://` in place of `https://`. They
// come from anywhere (a web page, a chat, another app), so each is checked here with no Electron
// in it, and only an invitation, rebuilt from its parts, is ever opened.

export const PROTOCOL = 'trioditis'

export interface Invitation {
  /** The server the invitation is for. */
  origin: string
  /** The invitation page on it, with nothing but its email address and token. */
  url: string
}

/** Invitation tokens are base64url (randomToken in the backend), 32 random bytes. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/
/** An email address as far as a link needs it: the sign-up form checks the rest. */
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,255}$/u

/**
 * The invitation a `trioditis://` link names, or null for anything else: another path, another
 * scheme, extra parameters, a user name or password in the address, or an address the picker
 * wouldn't take. A server on this machine is plain http, as `pnpm dev` serves it; any other is
 * https.
 */
export function invitationFrom(link: string): Invitation | null {
  if (typeof link !== 'string' || link.length > 4096) return null
  const rest = /^trioditis:\/\/([^/\\?#]+)(\/.*)?$/is.exec(link.trim())
  if (!rest) return null
  let url: URL
  try {
    url = new URL(`https://${rest[1]}${rest[2] ?? ''}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.pathname !== '/invite') return null
  const server = normalizeServer(`${isLoopback(url.hostname) ? 'http' : 'https'}://${url.host}`)
  if ('error' in server) return null
  const search = [...url.searchParams]
  const fragment = [...new URLSearchParams(url.hash.slice(1))]
  if (search.length !== 1 || search[0]![0] !== 'email') return null
  if (fragment.length !== 1 || fragment[0]![0] !== 'token') return null
  const email = search[0]![1].trim()
  const token = fragment[0]![1]
  if (email.length > 320 || !EMAIL.test(email) || !TOKEN.test(token)) return null
  return { origin: server.origin, url: `${server.origin}/invite?${new URLSearchParams({ email })}#token=${token}` }
}

/**
 * The link in a launch's arguments, where Windows and Linux put it. Only an argument that is
 * itself a `trioditis:` link counts, so a flag's value can't be taken for one.
 */
export function linkArgument(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${PROTOCOL}:`))
}

/**
 * What Google's sign-in hands back for Google Contacts, which the server's
 * /google-contacts.html passes on as `trioditis://<server>/google-contacts#state=…&access_token=…`
 * (or `#state=…&error=…`), since the sign-in happens in the system's browser. Only the server
 * that asked, with the state it asked with, ever gets it (main.ts).
 */
export interface GoogleAnswer {
  origin: string
  state: string
  accessToken?: string
  error?: string
}

/** The app's own states (src/lib/google-sign-in.ts), Google's tokens, and its error codes. */
const STATE = /^d[A-Za-z0-9_-]{16,128}$/
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/
const ERROR = /^[a-z_]{1,64}$/

/** The Google sign-in answer a `trioditis://` link carries, or null for anything else. */
export function googleAnswerFrom(link: string): GoogleAnswer | null {
  if (typeof link !== 'string' || link.length > 8192) return null
  const rest = /^trioditis:\/\/([^/\\?#]+)(\/.*)?$/is.exec(link.trim())
  if (!rest) return null
  let url: URL
  try {
    url = new URL(`https://${rest[1]}${rest[2] ?? ''}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.pathname !== '/google-contacts' || url.search) return null
  const server = normalizeServer(`${isLoopback(url.hostname) ? 'http' : 'https'}://${url.host}`)
  if ('error' in server) return null
  const fragment = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(url.hash.slice(1))) {
    if (fragment.has(key)) return null
    fragment.set(key, value)
  }
  const state = fragment.get('state') ?? ''
  const accessToken = fragment.get('access_token')
  const error = fragment.get('error')
  if (!STATE.test(state) || fragment.size !== 2) return null
  if (accessToken !== undefined)
    return ACCESS_TOKEN.test(accessToken) ? { origin: server.origin, state, accessToken } : null
  if (error !== undefined) return ERROR.test(error) ? { origin: server.origin, state, error } : null
  return null
}

/**
 * Whether the app may open this for Google Contacts' sign-in in the system's browser: Google's
 * sign-in page, asking only to read contacts, answering to the server's own
 * /google-contacts.html with one of the app's states.
 */
export function googleSignInState(target: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') return null
  const q = url.searchParams
  const state = q.get('state') ?? ''
  if (q.get('redirect_uri') !== `${origin}/google-contacts.html` || q.get('response_type') !== 'token') return null
  if (q.get('scope') !== 'https://www.googleapis.com/auth/contacts.readonly' || !STATE.test(state)) return null
  return state
}

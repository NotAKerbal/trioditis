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

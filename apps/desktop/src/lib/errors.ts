/** The `data` a ConvexError carries: a sentence, or `{ code, message }`. */
function dataOf(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined
}

/** Turns whatever an auth call or a Convex function threw into a sentence for the person. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown }
    // Convex functions throw ConvexError with a sentence in `data`, or `{ code, message }`;
    // Better Auth returns `message`.
    const data = dataOf(error)
    if (typeof data === 'string') return data
    if (data && typeof data === 'object') {
      // Its own `message` is only that data as JSON: nothing to show if there's no sentence.
      const message = (data as { message?: unknown }).message
      return typeof message === 'string' && message ? message : fallback
    }
    if (typeof e.message === 'string' && e.message && !e.message.startsWith('[CONVEX')) return e.message
  }
  return fallback
}

/**
 * What to say when an auth request was refused for too many attempts (a 429), with the wait
 * the server gave (Retry-After); null for any other error.
 */
export function tooManyAttempts(error: unknown, retryAfterSeconds: number | null): string | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  if (status !== 429) return null
  if (!retryAfterSeconds) return 'Too many attempts. Wait a moment, then try again.'
  return `Too many attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`
}

/** The `code` of a ConvexError thrown with `{ code, message }`, if that's what it is. */
export function errorCode(error: unknown): string | undefined {
  const data = dataOf(error)
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether a key write was refused because the page's session isn't the browser's any more
 * (the `sessionId` the page passed, see docs/architecture/client-api.md): the page should
 * start again, as whoever is signed in now, rather than offer to try again.
 */
export const sessionChanged = (error: unknown) => errorCode(error) === 'sessionChanged'

/**
 * Whether an auth route (Better Auth's, like adding a passkey) refused because the page's session
 * isn't the browser's any more: 409 with code sessionChanged. The page should start again.
 */
export function authSessionChanged(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { status?: unknown; code?: unknown }
  return e.status === 409 && e.code === 'sessionChanged'
}

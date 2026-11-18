/** Turns whatever an auth call or a Convex function threw into a sentence for the person. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const e = error as { data?: unknown; message?: unknown }
    // Convex functions throw ConvexError with a sentence in `data`; Better Auth returns `message`.
    if (typeof e.data === 'string') return e.data
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

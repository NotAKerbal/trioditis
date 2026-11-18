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

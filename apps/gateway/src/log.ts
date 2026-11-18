import { ConvexError } from 'convex/values'

/**
 * Phrases an error may be logged by. Errors can quote what they refused (field names, values,
 * sealed payloads), and nothing a person typed should reach a log, so a log line names the
 * kind of error and which of these it matched, and nothing else from its message.
 */
const KNOWN = [
  'fetch failed',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'timeout',
  'aborted',
  'ArgumentValidationError',
  'Not the gateway',
  'Server Error',
  'Body too large',
] as const

/** The gateway functions' own error messages, which are fixed strings. */
const BACKEND_MESSAGES: ReadonlySet<string> = new Set([
  'Not the gateway',
  'Host network mismatch',
  'Batch too large',
  'Host ID too long',
])

export function describeError(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === 'string' && BACKEND_MESSAGES.has(error.data)) {
    return `ConvexError: ${error.data}`
  }
  const name = error instanceof Error ? error.name : typeof error
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  const text = [error instanceof Error ? error.message : '', cause instanceof Error ? cause.message : ''].join(' ')
  const matched = KNOWN.filter((phrase) => text.includes(phrase))
  return matched.length > 0 ? `${name}: ${matched.join(', ')}` : name
}

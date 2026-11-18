/**
 * An error as one short line, for logs. Convex validation errors quote the value they
 * refused, which can include sealed payloads or IDs; everything from "Value:" on is dropped,
 * and the line is cut short. Nothing a person typed should reach a log.
 */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const firstLine = text.split('\n')[0] ?? ''
  const withoutValue = firstLine.split(/\bValue:/)[0] ?? ''
  return withoutValue.slice(0, 200).trim()
}

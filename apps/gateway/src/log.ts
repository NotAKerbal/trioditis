/**
 * An error as one short line, for logs. Errors can quote the values they refused, which can
 * include sealed payloads or IDs, so only the first line is kept, everything from "Value:" on
 * is dropped, quoted strings and JSON are replaced by "…", and the line is cut short. Nothing
 * a person typed should reach a log.
 */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const firstLine = text.split('\n')[0] ?? ''
  const withoutValue = firstLine.split(/\bValue:/)[0] ?? ''
  const withoutQuotes = withoutValue
    .replace(/"(?:[^"\\]|\\.)*"/g, '…')
    .replace(/'(?:[^'\\]|\\.)*'/g, '…')
    .replace(/[{[].*[}\]]/g, '…')
  return withoutQuotes.slice(0, 200).trim()
}

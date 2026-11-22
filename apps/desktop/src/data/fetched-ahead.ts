// What couldn't be fetched ahead (WarmChats). The cache keeps a page that failed, under the same
// key the chat pane or the People window would ask with, for 5 minutes after it's let go; asked
// the same way, it would fail again on the first open even once the server has recovered. So
// those open asking afresh instead, for a little longer than the cache keeps the failure.

const FAILED_FOR_MS = 6 * 60_000

const failed = new Map<string, number>()

/** Notes that fetching this ahead failed: `chat:<id>` or `people`. */
export function fetchAheadFailed(key: string, now = Date.now()) {
  failed.set(key, now)
}

/** Whether fetching this ahead failed recently enough that the cache may still hold the failure. */
export function failedAhead(key: string, now = Date.now()): boolean {
  const at = failed.get(key)
  if (at === undefined) return false
  if (now - at <= FAILED_FOR_MS) return true
  failed.delete(key)
  return false
}

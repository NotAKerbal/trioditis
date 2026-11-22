// Every function execution the backend reports, from its log stream (the one `npx convex logs`
// reads: /api/stream_function_logs, with the admin key). Each completion says how long the
// function ran, whether its answer was cached, what it read and wrote, and how it failed. Only
// those numbers and the first line of an error are kept; the functions never log content.

/** A Convex error that means the function ran out of time, as the backend words it. */
export const TIMEOUT = /timed out|ran for too long|time limit|exceeded the maximum (execution|duration)|took too long/i

/** The function's name as the report shows it: `component/module:function` for a component's. */
export function functionName(entry) {
  return entry.componentPath ? `${entry.componentPath}/${entry.identifier}` : entry.identifier
}

/** One completion as the report keeps it. */
export function record(entry) {
  const error = entry.error ? String(entry.error).split('\n')[0].slice(0, 240) : null
  const usage = entry.usageStats ?? {}
  return {
    fn: functionName(entry),
    type: entry.udfType,
    caller: entry.caller ?? null,
    at: (entry.executionTimestamp ?? entry.timestamp) * 1000,
    ms: (entry.executionTime ?? 0) * 1000,
    userMs: (entry.userExecutionTime ?? 0) * 1000,
    cached: entry.cachedResult === true,
    error,
    timeout: error !== null && TIMEOUT.test(error),
    occ: entry.occInfo ? true : false,
    retry: entry.willRetry === true,
    readDocs: usage.databaseReadDocuments ?? 0,
    readBytes: usage.databaseReadBytes ?? 0,
    writeBytes: usage.databaseWriteBytes ?? 0,
  }
}

/**
 * Collects completions until stopped. `onRecord` sees each one; `records` keeps them all.
 * The stream is polled, as the CLI polls it; a failed poll is tried again.
 */
export function collectLogs({ convexUrl, adminKey, onRecord = () => {} }) {
  const records = []
  let stopped = false
  let cursor = 0
  let failures = 0
  let controller = null
  const loop = (async () => {
    while (!stopped) {
      try {
        controller = new AbortController()
        const response = await fetch(`${convexUrl}/api/stream_function_logs?cursor=${cursor}`, {
          headers: { authorization: `Convex ${adminKey}` },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`log stream answered ${response.status}`)
        const { entries, newCursor } = await response.json()
        cursor = newCursor
        for (const entry of entries) {
          if (entry.kind !== 'Completion') continue
          const r = record(entry)
          records.push(r)
          onRecord(r)
        }
      } catch (error) {
        if (stopped) break
        failures++
        await new Promise((r) => setTimeout(r, Math.min(5000, 250 * failures)))
      }
    }
  })()
  return {
    records,
    get failures() {
      return failures
    },
    /** Waits a moment for the stream to catch up, then stops. */
    async stop(settleMs = 3000) {
      await new Promise((r) => setTimeout(r, settleMs))
      stopped = true
      controller?.abort()
      await loop
    },
  }
}

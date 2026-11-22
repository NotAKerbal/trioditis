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

/** The longest a poll may take; the stream holds a poll open while it has nothing new. */
const POLL_MS = 120_000

/**
 * Whether the stream was read all through `[from, to]`: a poll answered by `from`, one after
 * `to`, and none of the gaps between answered polls longer than `maxGapMs`. Without that, the
 * function numbers could be missing executions, so the run can't be judged.
 */
export function coverage(answeredAt, from, to, maxGapMs = POLL_MS + 10_000) {
  const inside = answeredAt.filter((t) => t >= from && t <= to)
  const before = answeredAt.filter((t) => t < from).at(-1)
  const after = answeredAt.find((t) => t > to)
  if (before === undefined)
    return { ok: false, detail: 'the function log stream had not answered when measuring began' }
  if (after === undefined)
    return { ok: false, detail: 'the function log stream stopped answering before measuring ended' }
  let gap = 0
  const points = [before, ...inside, after]
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, points[i] - points[i - 1])
  if (gap > maxGapMs)
    return { ok: false, detail: `the function log stream went ${Math.round(gap / 1000)} s without answering` }
  return { ok: true, detail: `read throughout (longest wait ${Math.round(gap / 1000)} s)` }
}

/**
 * Collects completions until stopped. `onRecord` sees each one; `records` keeps them all, and
 * `answeredAt` when each poll was answered, for `coverage`. The stream is polled, as the CLI
 * polls it; a failed poll is tried again. `ready` resolves once a poll has been answered, and
 * rejects if none is within a minute.
 */
export function collectLogs({ convexUrl, adminKey, onRecord = () => {} }) {
  const records = []
  const answeredAt = []
  let stopped = false
  let cursor = 0
  let failures = 0
  let lastError = ''
  let controller = null
  const loop = (async () => {
    while (!stopped) {
      try {
        controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), POLL_MS)
        let body
        try {
          const response = await fetch(`${convexUrl}/api/stream_function_logs?cursor=${cursor}`, {
            headers: { authorization: `Convex ${adminKey}` },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`log stream answered ${response.status}`)
          body = await response.json()
        } finally {
          clearTimeout(timer)
        }
        answeredAt.push(Date.now())
        cursor = body.newCursor
        for (const entry of body.entries) {
          if (entry.kind !== 'Completion') continue
          const r = record(entry)
          records.push(r)
          onRecord(r)
        }
      } catch (error) {
        if (stopped) break
        failures++
        lastError = String(error?.message ?? error).slice(0, 200)
        await new Promise((r) => setTimeout(r, Math.min(5000, 250 * failures)))
      }
    }
  })()
  const ready = (async () => {
    const until = Date.now() + 60_000
    while (answeredAt.length === 0) {
      if (Date.now() > until)
        throw new Error(`The function log stream never answered${lastError ? `: ${lastError}` : ''}.`)
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  return {
    records,
    answeredAt,
    ready,
    get failures() {
      return failures
    },
    /**
     * Stops once a poll has been answered after `after` (so everything up to it is in), or
     * after POLL_MS of waiting for one.
     */
    async stop({ after = Date.now() } = {}) {
      const until = Date.now() + POLL_MS
      while (!answeredAt.some((t) => t > after + 1000) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 200))
      }
      stopped = true
      controller?.abort()
      await loop
    },
  }
}

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
    // When it completed: a cached answer's executionTimestamp is when it first ran, maybe long
    // before it was served.
    at: entry.timestamp * 1000,
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
 * Whether the stream was read all through `[from, to]`, from its polls (`{ at, cursor, lost }`:
 * when each was answered, the backend's cursor after it, and whether it may have dropped
 * executions): a poll answered by `from`; the backend's cursor past `to` in a later one; no
 * poll that may have lost executions; and no gap between answered polls longer than `maxGapMs`.
 * Without that, the function numbers could be missing executions, so the run can't be judged.
 */
export function coverage(polls, from, to, maxGapMs = POLL_MS + 10_000) {
  const before = polls.filter((p) => p.at < from).at(-1)
  const after = polls.find((p) => p.cursor > to)
  if (!before) return { ok: false, detail: 'the function log stream had not answered when measuring began' }
  if (!after) return { ok: false, detail: "the function log stream didn't get past the end of measuring" }
  const window = polls.filter((p) => p.at >= before.at && p.at <= after.at)
  if (window.some((p) => p.lost))
    return { ok: false, detail: 'the function log may have dropped executions between two polls' }
  let gap = 0
  for (let i = 1; i < window.length; i++) gap = Math.max(gap, window[i].at - window[i - 1].at)
  if (gap > maxGapMs)
    return { ok: false, detail: `the function log stream went ${Math.round(gap / 1000)} s without answering` }
  return { ok: true, detail: `read throughout (longest wait ${Math.round(gap / 1000)} s)` }
}

/**
 * Collects completions until stopped. `onRecord` sees each one; `records` keeps them all, and
 * `polls` each answered poll, for `coverage`. The stream is polled, as the CLI polls it; a failed
 * poll is tried again. `ready` resolves once a poll has been answered, and rejects if none is
 * within a minute. A poll that returns as many entries as the backend keeps (`buffer`) may have
 * missed some, since the backend serves only what it still has.
 */
export function collectLogs({ convexUrl, adminKey, buffer, onRecord = () => {} }) {
  const records = []
  const polls = []
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
        // The whole answer is read before any of it is kept, so a malformed one is a failed
        // poll, retried from the same cursor, never a gap that looks covered.
        if (
          !Array.isArray(body?.entries) ||
          !Number.isFinite(body.newCursor) ||
          !body.entries.every((e) => typeof e === 'object' && e !== null && typeof e.kind === 'string')
        ) {
          throw new Error('log stream answered something else')
        }
        const batch = []
        for (const entry of body.entries) {
          if (entry.kind !== 'Completion') continue
          // Everything the verdict reads from it: a completion missing any is a malformed answer.
          if (
            typeof entry.identifier !== 'string' ||
            !Number.isFinite(entry.timestamp) ||
            !Number.isFinite(entry.executionTime) ||
            entry.executionTime < 0
          ) {
            throw new Error('log stream gave a completion without its function, time or duration')
          }
          batch.push(record(entry))
        }
        // Past the first poll, which returns whatever the backend still holds from before.
        polls.push({ at: Date.now(), cursor: body.newCursor, lost: cursor > 0 && body.entries.length >= buffer })
        cursor = body.newCursor
        for (const r of batch) {
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
    while (polls.length === 0 && !stopped) {
      if (Date.now() > until)
        throw new Error(`The function log stream never answered${lastError ? `: ${lastError}` : ''}.`)
      await new Promise((r) => setTimeout(r, 200))
    }
  })()
  const cancel = async () => {
    stopped = true
    controller?.abort()
    await loop
  }
  return {
    records,
    polls,
    ready,
    get failures() {
      return failures
    },
    /**
     * Stops once the backend's cursor is past `after` (everything up to it is in), or after
     * POLL_MS of waiting for that.
     */
    async stop({ after = Date.now() } = {}) {
      const until = Date.now() + POLL_MS
      while (!polls.some((p) => p.cursor > after) && Date.now() < until && !stopped) {
        await new Promise((r) => setTimeout(r, 200))
      }
      await cancel()
    },
    /** Stops at once. */
    cancel,
  }
}

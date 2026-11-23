// The numbers the report gives and the checks it makes, from the function log (logs.mjs) and
// what the simulated clients and bridge hosts saw. Pure, so it is tested on its own
// (scripts/test/load-test.test.mjs).

/** The `p`th percentile (0–100) of `values`, nearest-rank; null for none. */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    // Not Math.max(...values): a long run's samples are too many to spread into a call.
    max: values.length ? values.reduce((a, b) => (b > a ? b : a), -Infinity) : null,
  }
}

/**
 * One row per function: how often it ran, how long, how it failed, what it read. Cached answers
 * are counted but left out of the times, since they cost the backend next to nothing. Sorted by
 * total execution time, the share of the backend's time each took: the most expensive first.
 */
export function byFunction(records, { minutes }) {
  const groups = new Map()
  for (const r of records) {
    let g = groups.get(r.fn)
    if (!g)
      groups.set(
        r.fn,
        (g = {
          fn: r.fn,
          type: r.type,
          runs: [],
          cached: 0,
          errors: 0,
          timeouts: 0,
          occ: 0,
          readDocs: 0,
          readBytes: 0,
          errorKinds: new Map(),
        }),
      )
    if (r.cached) {
      g.cached++
      continue
    }
    g.runs.push(r.ms)
    g.readDocs += r.readDocs
    g.readBytes += r.readBytes
    if (r.occ) g.occ++
    if (r.error) {
      g.errors++
      if (r.timeout) g.timeouts++
      const kind = errorKind(r.error)
      g.errorKinds.set(kind, (g.errorKinds.get(kind) ?? 0) + 1)
    }
  }
  const total = [...groups.values()].reduce((a, g) => a + g.runs.reduce((b, ms) => b + ms, 0), 0)
  return [...groups.values()]
    .map((g) => {
      const totalMs = g.runs.reduce((a, ms) => a + ms, 0)
      const s = summarize(g.runs)
      return {
        fn: g.fn,
        type: g.type,
        calls: g.runs.length + g.cached,
        executed: g.runs.length,
        cached: g.cached,
        perMinute: minutes > 0 ? (g.runs.length + g.cached) / minutes : null,
        totalMs,
        share: total > 0 ? totalMs / total : 0,
        p50: s.p50,
        p95: s.p95,
        p99: s.p99,
        max: s.max,
        errors: g.errors,
        timeouts: g.timeouts,
        occ: g.occ,
        avgReadDocs: g.runs.length ? g.readDocs / g.runs.length : 0,
        avgReadKiB: g.runs.length ? g.readBytes / g.runs.length / 1024 : 0,
        errorKinds: Object.fromEntries(g.errorKinds),
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}

/** An error's first line with IDs and numbers taken out, so the same failure counts once. */
export function errorKind(error) {
  return error
    .replace(/\b[0-9a-z]{20,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .slice(0, 160)
}

/** How many executions ran in each minute, and how many timed out or failed then. */
export function perMinute(records, startMs) {
  const minutes = []
  for (const r of records) {
    const i = Math.max(0, Math.floor((r.at - startMs) / 60_000))
    minutes[i] ??= { minute: i + 1, executions: 0, timeouts: 0, errors: 0 }
    minutes[i].executions++
    if (r.error) minutes[i].errors++
    if (r.timeout) minutes[i].timeouts++
  }
  return Array.from(minutes, (m, i) => m ?? { minute: i + 1, executions: 0, timeouts: 0, errors: 0 })
}

export const DEFAULT_BUDGET = { p95: 250, p99: 500 }

/**
 * The checks the run must pass: no function timed out; each function that ran often enough to
 * judge kept its p95 and p99 inside its budget; the clients saw no errors; every push from a
 * bridge host was taken. Returns `{ passed, checks }`.
 */
export function evaluate({
  rows,
  client,
  bridges,
  logs = { ok: true, detail: 'not checked' },
  budgets = {},
  defaultBudget = DEFAULT_BUDGET,
  minRuns = 20,
}) {
  const checks = []
  // First: without the whole log, the function checks below could pass on missing data.
  checks.push({ name: 'The function log was read all through the run', passed: logs.ok, detail: logs.detail })
  const timeouts = rows.reduce((a, r) => a + r.timeouts, 0)
  checks.push({
    name: 'No function timeouts',
    passed: timeouts === 0,
    detail:
      timeouts === 0
        ? 'none'
        : `${timeouts} timed out: ${rows
            .filter((r) => r.timeouts)
            .map((r) => `${r.fn} ×${r.timeouts}`)
            .join(', ')}`,
  })
  const over = []
  for (const row of rows) {
    if (row.executed < minRuns) continue
    const budget = { ...defaultBudget, ...budgets[row.fn] }
    if (row.p95 > budget.p95) over.push(`${row.fn} p95 ${fmt(row.p95)} > ${budget.p95} ms`)
    if (row.p99 > budget.p99) over.push(`${row.fn} p99 ${fmt(row.p99)} > ${budget.p99} ms`)
  }
  checks.push({
    name: `Every function's p95 ≤ ${defaultBudget.p95} ms and p99 ≤ ${defaultBudget.p99} ms (unless budgeted otherwise, ≥ ${minRuns} runs)`,
    passed: over.length === 0,
    detail: over.length === 0 ? 'all within budget' : over.join('; '),
  })
  // A client that hadn't finished opening the app put only part of its load on the backend.
  if (client.requested !== undefined) {
    checks.push({
      name: 'Every client opened the app',
      passed: client.started >= client.requested,
      detail: `${client.started} of ${client.requested} finished starting while measured`,
    })
  }
  checks.push({
    name: 'The clients saw no errors',
    passed: client.errors === 0,
    detail:
      client.errors === 0
        ? 'none'
        : Object.entries(client.errorKinds)
            .map(([k, n]) => `${n}× ${k}`)
            .join('; '),
  })
  checks.push({
    name: 'Every bridge host push was taken',
    passed: bridges.failedPushes === 0,
    detail:
      bridges.failedPushes === 0
        ? `${bridges.pushes} pushes`
        : `${bridges.failedPushes} of ${bridges.pushes} pushes failed or went unanswered`,
  })
  return { passed: checks.every((c) => c.passed), checks }
}

export const fmt = (ms) => (ms === null || ms === undefined ? '–' : ms >= 100 ? `${Math.round(ms)}` : ms.toFixed(1))

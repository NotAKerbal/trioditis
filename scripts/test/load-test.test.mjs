// The load test's own logic, without Docker: the made-up inbox, how the function log is read,
// the numbers and checks, and the report. The run itself is `pnpm load-test` (nightly CI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inboxSummary, longTail, makeInbox, random } from '../load-test/inbox.mjs'
import { coverage, functionName, record, TIMEOUT } from '../load-test/logs.mjs'
import { byFunction, errorKind, evaluate, percentile, perMinute } from '../load-test/stats.mjs'
import { markdownReport } from '../load-test/report.mjs'
import { composeImage } from '../load-test/stack.mjs'
import { estimateBytes, reserveBytes, room, RESERVE_BYTES } from '../load-test/preflight.mjs'

void test('the same seed makes the same inbox, of the size asked for', () => {
  const shape = { seed: 3, chats: 120, messages: 2000, people: 40 }
  const a = makeInbox(shape, 1_800_000_000_000)
  const b = makeInbox(shape, 1_800_000_000_000)
  assert.deepEqual(a, b)
  const summary = inboxSummary(a)
  assert.equal(summary.chats, 120)
  assert.equal(summary.messages, 2000)
  assert.equal(summary.people, 40)
  assert.notDeepEqual(makeInbox({ ...shape, seed: 4 }, 1_800_000_000_000).chats[0], a.chats[0])
})

void test("the inbox's IDs are unique and its messages are in order", () => {
  const inbox = makeInbox({ chats: 200, messages: 5000, people: 50 })
  const portals = new Set(inbox.chats.map((c) => c.portalId))
  assert.equal(portals.size, inbox.chats.length)
  const events = new Set()
  for (const chat of inbox.chats) {
    for (let i = 0; i < chat.messages.length; i++) {
      const m = chat.messages[i]
      assert.ok(!events.has(m.eventId))
      events.add(m.eventId)
      if (i > 0) assert.ok(m.networkTs >= chat.messages[i - 1].networkTs - chat.messages.length * 1000)
      if ('ghostId' in m.sender) assert.ok(chat.members.includes(m.sender.ghostId))
    }
  }
  assert.equal(new Set(inbox.people.map((p) => p.personKey)).size, inbox.people.length)
  for (const p of inbox.people) assert.match(p.personKey, /^[A-Za-z0-9_-]{16,64}$/)
  for (const l of inbox.labels) assert.match(l.labelKey, /^[A-Za-z0-9_-]{16,64}$/)
})

void test('unread chats end with messages from someone else that came live', () => {
  const inbox = makeInbox({ chats: 300, messages: 3000 })
  const unread = inbox.chats.filter((c) => c.unread)
  assert.ok(unread.length > 0)
  for (const chat of unread) {
    const last = chat.messages.at(-1)
    assert.equal(last.historical, false)
    assert.ok('ghostId' in last.sender)
  }
})

void test('a long tail gives every chat a message and adds up to the total', () => {
  const counts = longTail(10_000, 300, random(1))
  assert.equal(counts.length, 300)
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    10_000,
  )
  assert.ok(Math.min(...counts) >= 1)
  assert.ok(Math.max(...counts) > 100 * Math.min(...counts))
})

void test('a log entry becomes a record of numbers, naming a component function with its path', () => {
  const entry = {
    kind: 'Completion',
    udfType: 'Query',
    componentPath: 'betterAuth',
    identifier: 'adapter:findOne',
    timestamp: 1_800_000_000.5,
    executionTimestamp: 1_800_000_000.25,
    executionTime: 0.0425,
    userExecutionTime: 0.04,
    cachedResult: false,
    caller: 'SyncWorker',
    error: null,
    occInfo: null,
    usageStats: { databaseReadDocuments: 12, databaseReadBytes: 4096, databaseWriteBytes: 0 },
  }
  const r = record(entry)
  assert.equal(r.fn, 'betterAuth/adapter:findOne')
  assert.equal(r.at, 1_800_000_000_250)
  assert.equal(r.ms, 42.5)
  assert.equal(r.readDocs, 12)
  assert.equal(r.timeout, false)
  assert.equal(functionName({ identifier: 'chats:list', componentPath: null }), 'chats:list')
  const timedOut = record({ ...entry, error: 'Function execution timed out (maximum duration: 1s)\nmore' })
  assert.equal(timedOut.timeout, true)
  assert.equal(timedOut.error, 'Function execution timed out (maximum duration: 1s)')
  assert.ok(TIMEOUT.test('Your function ran for too long'))
  assert.ok(!TIMEOUT.test('Uncaught ConvexError: That chat doesn’t exist.'))
})

void test('percentiles are nearest-rank', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(values, 50), 50)
  assert.equal(percentile(values, 95), 95)
  assert.equal(percentile(values, 99), 99)
  assert.equal(percentile([7], 99), 7)
  assert.equal(percentile([], 50), null)
})

const rec = (fn, ms, extra = {}) => ({
  fn,
  type: 'Query',
  ms,
  at: 0,
  cached: false,
  error: null,
  timeout: false,
  occ: false,
  readDocs: 1,
  readBytes: 100,
  ...extra,
})

void test('functions are ranked by their total time, cached answers counted but not timed', () => {
  const records = [
    ...Array.from({ length: 10 }, () => rec('a:cheap', 5)),
    ...Array.from({ length: 3 }, () => rec('b:costly', 400)),
    rec('b:costly', 0, { cached: true }),
    rec('c:fails', 1000, { error: 'Function execution timed out', timeout: true }),
  ]
  const rows = byFunction(records, { minutes: 2 })
  assert.deepEqual(
    rows.map((r) => r.fn),
    ['b:costly', 'c:fails', 'a:cheap'],
  )
  const costly = rows[0]
  assert.equal(costly.calls, 4)
  assert.equal(costly.cached, 1)
  assert.equal(costly.executed, 3)
  assert.equal(costly.perMinute, 2)
  assert.equal(costly.p95, 400)
  assert.equal(rows[1].timeouts, 1)
  assert.equal(rows[1].errorKinds['Function execution timed out'], 1)
})

void test('the checks fail on a timeout, a function over budget, a client error or a failed push', () => {
  const ok = { errors: 0, errorKinds: {} }
  const pushes = { pushes: 5, failedPushes: 0 }
  const fast = byFunction(
    Array.from({ length: 30 }, () => rec('a:fast', 10)),
    { minutes: 1 },
  )
  assert.equal(evaluate({ rows: fast, client: ok, bridges: pushes }).passed, true)

  const slow = byFunction(
    Array.from({ length: 30 }, () => rec('a:slow', 300)),
    { minutes: 1 },
  )
  const verdict = evaluate({ rows: slow, client: ok, bridges: pushes })
  assert.equal(verdict.passed, false)
  assert.match(verdict.checks[2].detail, /a:slow p95 300 > 250 ms/)
  // A budget of its own lets it through; too few runs to judge are left alone.
  assert.equal(
    evaluate({ rows: slow, client: ok, bridges: pushes, budgets: { 'a:slow': { p95: 400, p99: 400 } } }).passed,
    true,
  )
  assert.equal(evaluate({ rows: slow, client: ok, bridges: pushes, minRuns: 31 }).passed, true)

  const timedOut = byFunction([rec('a:t', 1000, { error: 'timed out', timeout: true })], { minutes: 1 })
  assert.equal(evaluate({ rows: timedOut, client: ok, bridges: pushes }).checks[1].passed, false)
  assert.equal(evaluate({ rows: fast, client: { errors: 1, errorKinds: { x: 1 } }, bridges: pushes }).passed, false)
  assert.equal(evaluate({ rows: fast, client: ok, bridges: { pushes: 5, failedPushes: 1 } }).passed, false)
})

void test('errors of one kind count together, without IDs or numbers', () => {
  assert.equal(errorKind('Chat k57abcdefghijklmnopqrstu not found after 1.5s'), 'Chat <id> not found after Ns')
})

void test('executions are counted minute by minute from the start', () => {
  const start = 1_000_000
  const minutes = perMinute(
    [rec('a', 1, { at: start + 10 }), rec('a', 1, { at: start + 130_000, error: 'x', timeout: true })],
    start,
  )
  assert.deepEqual(minutes, [
    { minute: 1, executions: 1, timeouts: 0, errors: 0 },
    { minute: 2, executions: 0, timeouts: 0, errors: 0 },
    { minute: 3, executions: 1, timeouts: 1, errors: 1 },
  ])
})

void test('the report shows the verdict, the ranking and the errors', () => {
  const functions = byFunction(
    [
      ...Array.from({ length: 30 }, () => rec('chats:list', 300)),
      rec('media:access', 1100, { error: 'timed out', timeout: true }),
    ],
    { minutes: 1 },
  )
  const verdict = evaluate({
    rows: functions,
    client: { errors: 0, errorKinds: {} },
    bridges: { pushes: 1, failedPushes: 0 },
  })
  const markdown = markdownReport({
    verdict,
    revision: 'abc123',
    date: '2026-11-21T00:00:00Z',
    profile: 'quick',
    cpus: 2,
    clients: 1,
    loadMinutes: 1,
    host: '4 CPUs, 16 GiB',
    images: { backend: 'ghcr.io/convex/convex-backend:x@sha256:y', postgres: 'postgres:17@sha256:z' },
    inbox: inboxSummary(makeInbox({ chats: 10, messages: 50, people: 5 })),
    seedSeconds: 12,
    databaseSize: '40 MB',
    rates: { backfillPerMinute: 150, backfillNetwork: 'signal', livePerMinute: 30 },
    traffic: { backfill: 1, live: 2, typing: 3, reactions: 4, receipts: 5, edits: 6 },
    bridges: {
      pushes: 1,
      failedPushes: 0,
      pushMs: { p95: 10 },
      batchSize: { p50: 3, p95: 50 },
      pushMsAll: [10],
      backlogAtEnd: 0,
      commands: {},
    },
    client: {
      errors: 0,
      errorKinds: {},
      actions: { 'open chat': 2 },
      peakSubscriptions: 40,
      opens: [100, 200],
      visible: [300],
      actionMs: [],
    },
    cpu: { mean: 150, max: 200 },
    functions,
    minutes: [{ minute: 1, executions: 31, timeouts: 1, errors: 1, cpu: 190 }],
    top: 25,
    settings: {},
  })
  assert.match(markdown, /^# Load test: FAILED/)
  assert.match(markdown, /\| 1 \| `chats:list` \|/)
  assert.match(markdown, /`media:access` \| 1 \| timed out/)
  assert.match(markdown, /Opening a chat, until it shows .* \| 2 \|/)
})

void test("the stack uses deploy/compose's pinned images", () => {
  assert.match(composeImage('backend'), /^ghcr\.io\/convex\/convex-backend:[0-9a-f]+@sha256:[0-9a-f]{64}$/)
  assert.match(composeImage('postgres'), /^postgres:.+@sha256:[0-9a-f]{64}$/)
  assert.throws(() => composeImage('nothing'), /no image for nothing/)
})

void test('preflight wants 20 GiB free plus twice the run, and inodes', () => {
  const need = RESERVE_BYTES + 2 * estimateBytes({ messages: 40_000, chats: 3000 })
  const fs =
    (freeGiB, inodes = 0.5) =>
    () => ({ bavail: (freeGiB * 1024 ** 3) / 4096, bsize: 4096, files: 1000, ffree: 1000 * inodes })
  assert.equal(room('/', need, fs(60)).ok, true)
  assert.equal(room('/', need, fs(21)).ok, false)
  assert.equal(room('/', need, fs(60, 0.05)).ok, false)
})

void test("the run can't pass on a function log it didn't read", () => {
  const ok = { errors: 0, errorKinds: {} }
  const pushes = { pushes: 5, failedPushes: 0 }
  const missing = coverage([], 1000, 2000)
  assert.equal(missing.ok, false)
  // No executions at all, and so no timeouts or slow functions, still fails.
  const verdict = evaluate({ rows: [], client: ok, bridges: pushes, logs: missing })
  assert.equal(verdict.passed, false)
  assert.equal(verdict.checks[0].passed, false)
  assert.equal(coverage([900, 1500, 2100], 1000, 2000).ok, true)
  assert.match(coverage([900, 1500], 1000, 2000).detail, /stopped answering/)
  assert.match(coverage([900, 200_000, 400_000], 1000, 300_000).detail, /went 200 s without answering/)
})

void test("a CI runner can keep less disk free than the shared machine's 20 GiB", () => {
  assert.equal(reserveBytes({}), 20 * 1024 ** 3)
  assert.equal(reserveBytes({ LOAD_DISK_RESERVE_GIB: '2' }), 2 * 1024 ** 3)
  assert.throws(() => reserveBytes({ LOAD_DISK_RESERVE_GIB: 'lots' }), /must be a number/)
  // What's written while measured counts too.
  assert.ok(
    estimateBytes({ messages: 1, chats: 1, minutes: 10, perMinute: 200 }) > estimateBytes({ messages: 1, chats: 1 }),
  )
})

#!/usr/bin/env node
// pnpm load-test: seeds a realistic inbox into a fresh self-hosted backend held to the live
// server's CPUs, then runs bridge hosts' writes and desktop clients' reads against it, and
// reports every function's cost. It fails when a function times out, runs over its budget, or
// a client sees an error. See apps/docs/src/content/docs/contributing/load-test.md.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus as hostCpus, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as crypto from '@trioditis/crypto'
import { dataDir, root } from '../lib.mjs'
import { setUpPerson } from './account.mjs'
import { driveTraffic, journalInbox, startBridges } from './bridges.mjs'
import { clientMetrics, startClients } from './clients.mjs'
import { inboxSummary, makeInbox } from './inbox.mjs'
import { collectLogs, coverage } from './logs.mjs'
import { preflight } from './preflight.mjs'
import { markdownReport } from './report.mjs'
import { seedClientState } from './seed.mjs'
import { docker, LOG_BUFFER, removeAbandonedStacks, startStack, stopStack } from './stack.mjs'
import { byFunction, evaluate, perMinute, summarize } from './stats.mjs'

/** Sizes and rates by profile. `quick` is for trying the harness; `nightly` is what CI runs. */
export const PROFILES = {
  quick: {
    chats: 300,
    messages: 5_000,
    people: 150,
    minutes: 3,
    clients: 1,
    backfillRate: 150,
    liveRate: 30,
    clickMs: 4_000,
  },
  nightly: {
    chats: 3_000,
    messages: 40_000,
    people: 800,
    minutes: 10,
    clients: 2,
    backfillRate: 150,
    liveRate: 60,
    clickMs: 3_000,
  },
  heavy: {
    chats: 6_000,
    messages: 100_000,
    people: 3_000,
    minutes: 15,
    clients: 3,
    backfillRate: 300,
    liveRate: 120,
    clickMs: 2_000,
  },
}

const OPTIONS = {
  profile: { type: 'string', default: 'nightly' },
  chats: { type: 'string' },
  messages: { type: 'string' },
  people: { type: 'string' },
  minutes: { type: 'string' },
  clients: { type: 'string' },
  cpus: { type: 'string', default: '2' },
  'backfill-rate': { type: 'string' },
  'backfill-network': { type: 'string', default: 'signal' },
  'backfill-page': { type: 'string', default: '50' },
  'live-rate': { type: 'string' },
  'click-ms': { type: 'string' },
  'budget-p95': { type: 'string', default: '250' },
  'budget-p99': { type: 'string', default: '500' },
  budgets: { type: 'string' },
  seed: { type: 'string', default: '1' },
  out: { type: 'string' },
  top: { type: 'string', default: '25' },
  keep: { type: 'boolean', default: false },
  'report-only': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
}

const HELP = `pnpm load-test [options]

  --profile quick|nightly|heavy   sizes and rates (default nightly)
  --chats N --messages N --people N
  --minutes N                     how long the measured load runs
  --clients N                     simulated desktop clients
  --cpus N                        CPUs the backend is held to while measured (default 2, the live server's)
  --backfill-rate N               backfilled messages a minute (--backfill-network, default signal),
                                  in pages of --backfill-page (default 50) journaled together
  --live-rate N                   live messages a minute, across every network
  --click-ms N                    how often each client clicks
  --budget-p95 MS --budget-p99 MS default per-function budget (250 / 500)
  --budgets FILE                  JSON of per-function budgets: { "chats:list": { "p95": 400 } }
  --out DIR                       where report.md and report.json go (default .data/load-test/<time>)
  --keep                          leave the containers running afterwards
  --report-only                   exit 0 even when a check fails
`

function settingsFrom(values) {
  const profile = PROFILES[values.profile]
  if (!profile) throw new Error(`No profile "${values.profile}": ${Object.keys(PROFILES).join(', ')}.`)
  const num = (name, fallback) => {
    if (values[name] === undefined) return fallback
    const value = Number(values[name])
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number.`)
    return value
  }
  return {
    profile: values.profile,
    chats: num('chats', profile.chats),
    messages: num('messages', profile.messages),
    people: num('people', profile.people),
    minutes: num('minutes', profile.minutes),
    clients: num('clients', profile.clients),
    cpus: num('cpus', 2),
    backfillRate: num('backfill-rate', profile.backfillRate),
    backfillNetwork: values['backfill-network'],
    backfillPage: Math.max(1, num('backfill-page', 50)),
    liveRate: num('live-rate', profile.liveRate),
    clickMs: num('click-ms', profile.clickMs),
    budget: { p95: num('budget-p95', 250), p99: num('budget-p99', 500) },
    budgets: values.budgets ? JSON.parse(readFileSync(values.budgets, 'utf8')) : {},
    seed: num('seed', 1),
    top: num('top', 25),
  }
}

function revision() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
    return dirty ? `${head}-dirty` : head
  } catch {
    return 'unknown'
  }
}

/** The backend container's CPU use, from its cgroup (cheap, and doesn't block the clients). */
function cpuMeter(containerName) {
  const id = docker(['inspect', '-f', '{{.Id}}', containerName], { allowFail: true })
  const paths = [`/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`, `/sys/fs/cgroup/docker/${id}/cpu.stat`]
  const path = paths.find((p) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  })
  const usage = () => Number(readFileSync(path, 'utf8').match(/^usage_usec (\d+)/m)?.[1] ?? 0)
  const samples = []
  if (!path) return { samples, stop() {} }
  let last = { at: performance.now(), usec: usage() }
  const timer = setInterval(() => {
    const now = { at: performance.now(), usec: usage() }
    samples.push({ at: Date.now(), percent: ((now.usec - last.usec) / 1000 / (now.at - last.at)) * 100 })
    last = now
  }, 5000)
  return { samples, stop: () => clearInterval(timer) }
}

const log = (message) => console.log(`[load-test ${new Date().toISOString().slice(11, 19)}] ${message}`)

async function main() {
  const { values } = parseArgs({ options: OPTIONS })
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const settings = settingsFrom(values)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = resolve(values.out ?? resolve(dataDir, 'load-test', stamp))
  mkdirSync(outDir, { recursive: true })
  preflight({
    messages: settings.messages,
    chats: settings.chats,
    minutes: settings.minutes,
    perMinute: settings.backfillRate + settings.liveRate,
    outDir,
    log,
  })

  await crypto.ready()
  const inbox = makeInbox({
    seed: settings.seed,
    chats: settings.chats,
    messages: settings.messages,
    people: settings.people,
  })
  if (!inbox.accounts.some((a) => a.network === settings.backfillNetwork)) {
    throw new Error(
      `--backfill-network ${settings.backfillNetwork} isn't one of the inbox's: ${inbox.accounts.map((a) => a.network).join(', ')}.`,
    )
  }
  const summary = inboxSummary(inbox)
  log(
    `Inbox: ${summary.chats} chats, ${summary.messages} messages, ${summary.reactions} reactions, ${summary.people} People cards`,
  )

  // Ctrl-C or a cancelled CI job still removes the containers, whatever stage the run is at.
  const name = `trioditis-load-${process.pid}`
  const onSignal = (signal) => {
    log(`${signal}: stopping`)
    if (values.keep) log(`Left running, as --keep asks: ${name}-*`)
    else stopStack(name)
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  removeAbandonedStacks(log)
  const stack = await startStack({
    name,
    networks: inbox.accounts.map((a) => a.network),
    keep: values.keep,
    log,
  })
  // Everything the run starts, so the one `finally` below stops all of it however it ends.
  let bridges
  let logs
  let cpu
  let traffic
  let stopClicks = []
  const clients = []
  const timers = []
  let cleaningUp = false
  try {
    const person = await setUpPerson(crypto, stack)
    log('Signed up the person and set up their key')

    // Seeding, with the backend unheld so it's quick: a first sync and its backfill.
    bridges = await startBridges({ crypto, stack, inbox, person })
    const seedStarted = Date.now()
    journalInbox(bridges, inbox)
    log(`Journaled ${bridges.hosts.reduce((a, h) => a + h.backlog, 0)} events; pushing them through the gateway`)
    bridges.start()
    timers.push(
      setInterval(() => log(`  ${bridges.hosts.reduce((a, h) => a + h.backlog, 0)} events left to push`), 15_000),
    )
    await bridges.drained()
    clearInterval(timers.pop())
    await person.refresh()
    const seeded = await seedClientState(crypto, person, inbox, stack.convexUrl, log)
    const seedSeconds = (Date.now() - seedStarted) / 1000
    log(`Seeded in ${seedSeconds.toFixed(0)} s (${seeded.chats} chats)`)

    // Measured: held to the live server's CPUs, with the clients opening the app and the
    // bridge hosts writing. Everything the verdict uses is from this window only.
    await stack.capCpus(settings.cpus)
    logs = collectLogs({ convexUrl: stack.convexUrl, adminKey: stack.adminKey, buffer: LOG_BUFFER })
    await logs.ready
    bridges.metrics.length = 0
    bridges.metrics.delivered.length = 0
    bridges.metrics.failures = 0
    for (const key of Object.keys(bridges.metrics.commands)) delete bridges.metrics.commands[key]
    log(`Backend held to ${settings.cpus} CPUs; measuring for ${settings.minutes} min`)
    cpu = cpuMeter(stack.containers.backend)
    const loadStarted = Date.now()
    const loadEnded = loadStarted + settings.minutes * 60_000
    traffic = driveTraffic(bridges, inbox, {
      backfillNetwork: settings.backfillNetwork,
      backfillPerMinute: settings.backfillRate,
      backfillPage: settings.backfillPage,
      livePerMinute: settings.liveRate,
      seed: settings.seed + 100,
    })
    // The window closes on time, from when it opened, however long the clients take to start:
    // then the writes and the CPU meter stop, and what the verdict uses is taken as it stands.
    const metrics = clientMetrics()
    let closed = null
    const closing = new Promise((resolve) => {
      timers.push(
        setTimeout(() => {
          closed = {
            seen: structuredClone(metrics),
            commands: { ...bridges.metrics.commands },
            backlogAtEnd: bridges.hosts.reduce((a, h) => a + h.backlog, 0),
          }
          traffic.stop()
          cpu.stop()
          resolve()
        }, settings.minutes * 60_000),
      )
    })
    let startError = null
    const starting = startClients({
      into: clients,
      metrics,
      count: settings.clients,
      convexUrl: stack.convexUrl,
      person,
      crypto,
      sent: traffic.sent,
      networks: inbox.accounts.map((a) => a.network),
      seed: settings.seed + 200,
      // Once the window has closed, no client starts adding load while the rest settles.
      cancelled: () => cleaningUp || closed !== null,
    }).catch((error) => {
      startError = error
    })
    await Promise.race([starting, closing])
    if (startError) throw startError
    if (!closed) {
      log(`${clients.length} client${clients.length === 1 ? '' : 's'} open`)
      stopClicks = clients.map((c) => c.runClicks(settings.clickMs))
    }
    const tick = setInterval(() => {
      const recent = logs.records.filter((r) => r.at > Date.now() - 60_000)
      log(
        `  ${((Date.now() - loadStarted) / 60_000).toFixed(1)} min: ${recent.length} executions in the last minute, ${recent.filter((r) => r.timeout).length} timeouts, CPU ${cpu.samples.at(-1)?.percent.toFixed(0) ?? '?'}%, backlog ${bridges.hosts.reduce((a, h) => a + h.backlog, 0)}`,
      )
    }, 30_000)
    timers.push(tick)
    await closing
    clearInterval(tick)
    const { seen, commands, backlogAtEnd } = closed
    await Promise.all(stopClicks.map((stop) => stop()))
    stopClicks = []
    await logs.stop({ after: loadEnded })
    for (const c of clients.splice(0)) await c.close()
    // After the hosts have stopped, so a push sent in the window and answered after it counts.
    await bridges.stop()
    const pushes = bridges.metrics.filter((m) => m.at >= loadStarted && m.at <= loadEnded)
    bridges = null

    const minutes = (loadEnded - loadStarted) / 60_000
    const measured = logs.records.filter((r) => r.at >= loadStarted && r.at <= loadEnded)
    const functions = byFunction(measured, { minutes })
    // Acknowledgement times are of pushes that were acknowledged; failures are counted apart.
    const pushMs = pushes.filter((m) => m.events > 0 && m.status === 200).map((m) => m.ms)
    const batchSizes = pushes.filter((m) => m.events > 0).map((m) => m.events)
    const bridgeStats = {
      pushes: pushes.length,
      failedPushes: pushes.filter((m) => m.status !== 200).length,
      batchSize: summarize(batchSizes),
      pushMs: summarize(pushMs),
      pushMsAll: pushMs,
      backlogAtEnd,
      commands,
    }
    const verdict = evaluate({
      rows: functions,
      client: { ...seen, requested: settings.clients },
      bridges: bridgeStats,
      logs: coverage(logs.polls, loadStarted, loadEnded),
      budgets: settings.budgets,
      defaultBudget: settings.budget,
    })
    const cpuPercents = cpu.samples.map((s) => s.percent)
    const minuteRows = perMinute(measured, loadStarted).map((m) => {
      const inMinute = cpu.samples
        .filter((s) => Math.floor((s.at - loadStarted) / 60_000) === m.minute - 1)
        .map((s) => s.percent)
      return { ...m, cpu: inMinute.length ? inMinute.reduce((a, b) => a + b, 0) / inMinute.length : null }
    })
    const report = {
      verdict,
      revision: revision(),
      date: new Date().toISOString(),
      profile: settings.profile,
      cpus: settings.cpus,
      clients: settings.clients,
      loadMinutes: Number(minutes.toFixed(1)),
      host: `${hostCpus().length} CPUs, ${(totalmem() / 1024 ** 3).toFixed(0)} GiB`,
      images: stack.images,
      inbox: summary,
      seedSeconds,
      databaseSize: stack.databaseSize(),
      rates: {
        backfillPerMinute: settings.backfillRate,
        backfillPage: settings.backfillPage,
        backfillNetwork: settings.backfillNetwork,
        livePerMinute: settings.liveRate,
      },
      traffic: traffic.counters,
      bridges: bridgeStats,
      client: {
        errors: seen.errors,
        errorKinds: seen.errorKinds,
        actions: seen.actions,
        peakSubscriptions: seen.peakSubscriptions,
        opens: seen.opens,
        failedOpens: seen.failedOpens,
        visible: seen.visible,
        actionMs: seen.actionMs ?? [],
      },
      cpu: {
        mean: cpuPercents.length ? cpuPercents.reduce((a, b) => a + b, 0) / cpuPercents.length : null,
        max: cpuPercents.length ? Math.max(...cpuPercents) : null,
      },
      functions,
      minutes: minuteRows,
      top: settings.top,
      settings,
      logStreamFailures: logs.failures,
    }
    const markdown = markdownReport(report)
    writeFileSync(resolve(outDir, 'report.md'), markdown)
    writeFileSync(
      resolve(outDir, 'report.json'),
      JSON.stringify(
        {
          ...report,
          client: {
            ...report.client,
            opens: summarize(report.client.opens),
            visible: summarize(report.client.visible),
            actionMs: summarize(report.client.actionMs),
          },
          bridges: { ...bridgeStats, pushMsAll: undefined },
        },
        null,
        2,
      ),
    )
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
    console.log('\n' + markdown)
    log(`Report: ${resolve(outDir, 'report.md')}`)
    return verdict.passed || values['report-only'] ? 0 : 1
  } finally {
    cleaningUp = true
    for (const t of timers) clearInterval(t)
    traffic?.stop()
    cpu?.stop()
    await logs?.cancel()
    await Promise.allSettled(stopClicks.map((stop) => stop()))
    for (const c of clients) await c.close().catch(() => {})
    if (bridges) await bridges.stop().catch(() => {})
    if (values.keep)
      log(
        `Left running: ${stack.convexUrl} (admin key in the containers' ./generate_admin_key.sh); remove with docker rm -f -v ${Object.values(stack.containers).join(' ')} && docker network rm ${name}-net`,
      )
    else stack.stop()
  }
}

process.exitCode = await main().catch((error) => {
  console.error(`load test: ${error.stack ?? error.message}`)
  return 2
})

// The updater's link to the backend (deploy/updater/updater.sh runs it in a one-off container on
// the server's network, from the bundle's Node image). It signs every call with UPDATER_SECRET,
// from its environment, never an argument.
//
//   updater-agent.mjs watch <seconds>
//     Waits for the admins' settings, up to <seconds> for a request, and prints one line:
//     `<channel> <auto> <request id or -> <request kind or ->`, such as `nightly 1 - -`. With a
//     request it prints as soon as there is one; otherwise when the time is up (0: as soon as
//     the backend answers).
//   updater-agent.mjs report
//     Sends the updater's report (updates:report) from UPDATER_* variables: UPDATER_STATE,
//     UPDATER_MESSAGE, UPDATER_DONE, UPDATER_CLAIM, UPDATER_CLAIM_CHANNEL, UPDATER_CLAIM_AUTO, UPDATER_CURRENT and UPDATER_CURRENT_AT, and
//     UPDATER_LATEST_CHANNEL, UPDATER_LATEST, UPDATER_LATEST_AT, UPDATER_LATEST_SUBJECT,
//     UPDATER_LATEST_NOTES, UPDATER_BEHIND, UPDATER_AHEAD and UPDATER_CHECKED_AT, and, for the
//     update just installed, UPDATER_INSTALLED_FROM, UPDATER_INSTALLED_TO and
//     UPDATER_INSTALLED_NOTES. Times are Unix seconds; notes are `<Label><tab><text>` lines.
//     The updater always passes UPDATER_LATEST_NOTES, empty or not; one that doesn't is from
//     before release notes.
//
// It exits 0 on success and 1 on any failure, with the reason on stderr.

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The client library, from the bundle's backend package in the image. Loaded only when run, so a
// test can import what this file works out without it.
function convex() {
  const backend = createRequire('/repo/packages/backend/package.json')
  return { ...backend('convex/browser'), ...backend('convex/server') }
}

// The backend's service on the bundle's network, as in compose.yml.
const url = process.env.CONVEX_URL || 'http://backend:3210'

const CHANNELS = new Set(['stable', 'nightly'])
const KINDS = new Set(['check', 'update'])
// What a request ID may be (randomToken in packages/backend/convex/lib/hash.ts), so the line
// printed always splits into exactly four words.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const COMMIT = /^[0-9a-f]{40}$/

function fail(message) {
  console.error(`updater-agent: ${message}`)
  process.exit(1)
}

/** The line `watch` prints for a poll result, after checking each word. */
function line(result) {
  if (!CHANNELS.has(result.channel)) fail(`unexpected channel ${JSON.stringify(result.channel)}`)
  const words = [result.channel, result.autoUpdate ? '1' : '0']
  if (result.request) {
    if (!REQUEST_ID.test(result.request.id) || !KINDS.has(result.request.kind)) fail('unexpected request')
    words.push(result.request.id, result.request.kind)
  } else {
    words.push('-', '-')
  }
  return words.join(' ')
}

async function watch(seconds, secret) {
  if (!/^[0-9]{1,5}$/.test(seconds ?? '')) fail('watch takes a number of seconds')
  const { ConvexClient, makeFunctionReference } = convex()
  const client = new ConvexClient(url)
  let latest
  await new Promise((resolve, reject) => {
    // Even `watch 0` waits for the first answer, for up to half a minute.
    const timer = setTimeout(resolve, Math.max(Number(seconds), 30) * 1000)
    client.onUpdate(
      makeFunctionReference('updates:poll'),
      { secret },
      (result) => {
        latest = result
        if (result.request || seconds === '0') {
          clearTimeout(timer)
          resolve()
        }
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
  await client.close()
  // Nothing arrived in time: the backend is up but slow, or unreachable.
  if (!latest) fail('no answer from the backend')
  console.log(line(latest))
}

function seconds(env, name) {
  const value = env[name]
  if (!/^[0-9]{1,12}$/.test(value ?? '')) throw new Error(`${name} must be Unix seconds`)
  return Number(value) * 1000
}

function count(env, name) {
  const value = env[name]
  if (!/^[0-9]{1,9}$/.test(value ?? '')) throw new Error(`${name} must be a count`)
  return Number(value)
}

// The labels a release note may have (scripts/release-notes.mjs), as the backend takes them.
const LABELS = { New: 'new', Improved: 'improved', Fixed: 'fixed', Security: 'security', Internal: 'internal' }

/** Release notes from the updater's `<Label><tab><text>` lines, leaving out any that don't fit. */
function notes(env, name) {
  const result = []
  for (const line of (env[name] ?? '').split('\n')) {
    const tab = line.indexOf('\t')
    const label = Object.hasOwn(LABELS, line.slice(0, tab)) ? LABELS[line.slice(0, tab)] : undefined
    const text = line.slice(tab + 1).trim()
    if (tab > 0 && label && text) result.push({ label, text })
  }
  return result
}

/**
 * The arguments of updates:report from the updater's UPDATER_* variables, or null for a report
 * this agent leaves for the next updater to send. Throws on a value that isn't what it should be.
 */
export function reportArgs(env, secret) {
  // An updater from before release notes passes none of their variables, even empty. It runs
  // this agent once it has installed this version, in the report that ends that update, and
  // exits right after; systemd then starts this version's updater. So that report is left: the
  // old updater keeps the update's two commits in its state, and the new one sends the report
  // again with the notes in between.
  const legacy = !Object.hasOwn(env, 'UPDATER_LATEST_NOTES')
  if (legacy && env.UPDATER_DONE && env.UPDATER_STATE === 'idle' && env.UPDATER_MESSAGE?.startsWith('Updated to ')) {
    return null
  }
  const args = { secret, state: env.UPDATER_STATE }
  if (env.UPDATER_MESSAGE) args.message = env.UPDATER_MESSAGE
  if (env.UPDATER_DONE) args.done = env.UPDATER_DONE
  if (env.UPDATER_CLAIM) args.claim = env.UPDATER_CLAIM
  if (env.UPDATER_CLAIM_CHANNEL) args.claimChannel = env.UPDATER_CLAIM_CHANNEL
  if (env.UPDATER_CLAIM_AUTO === '1') args.claimAuto = true
  if (env.UPDATER_CURRENT) {
    args.current = { commit: env.UPDATER_CURRENT, committedAt: seconds(env, 'UPDATER_CURRENT_AT') }
  }
  if (env.UPDATER_LATEST) {
    args.latest = {
      channel: env.UPDATER_LATEST_CHANNEL,
      commit: env.UPDATER_LATEST,
      committedAt: seconds(env, 'UPDATER_LATEST_AT'),
      subject: env.UPDATER_LATEST_SUBJECT ?? '',
      behind: count(env, 'UPDATER_BEHIND'),
      ahead: count(env, 'UPDATER_AHEAD'),
      checkedAt: seconds(env, 'UPDATER_CHECKED_AT'),
    }
    // Left out when there are none, so a report that has none fits a backend from before them.
    const latestNotes = notes(env, 'UPDATER_LATEST_NOTES')
    if (latestNotes.length) args.latest.notes = latestNotes
  }
  // Left out unless both ends are commits, so the report that ends an update always goes through.
  if (COMMIT.test(env.UPDATER_INSTALLED_FROM ?? '') && COMMIT.test(env.UPDATER_INSTALLED_TO ?? '')) {
    args.installed = {
      from: env.UPDATER_INSTALLED_FROM,
      to: env.UPDATER_INSTALLED_TO,
      notes: notes(env, 'UPDATER_INSTALLED_NOTES'),
    }
  }
  return args
}

/** Sends a report with `mutate` (updates:report), again without its notes if they're refused. */
export async function sendReport(mutate, args) {
  try {
    await mutate(args)
  } catch (error) {
    // A backend from before release notes refuses their fields. That's this agent's image
    // beside an older backend, as when going back after a failed update stopped partway: the
    // report goes again without them, so the updater isn't stuck sending it.
    const withNotes = args.latest?.notes || args.installed
    if (!withNotes || !/extra field/i.test(error instanceof Error ? error.message : String(error))) throw error
    const { installed: _installed, ...rest } = args
    const latest = args.latest && { ...args.latest }
    if (latest) delete latest.notes
    await mutate({ ...rest, ...(latest ? { latest } : {}) })
  }
}

async function report(secret) {
  const args = reportArgs(process.env, secret)
  if (!args) fail('leaving the end of this update for the new updater to report, with its release notes')
  const { ConvexHttpClient, makeFunctionReference } = convex()
  const client = new ConvexHttpClient(url)
  await sendReport((a) => client.mutation(makeFunctionReference('updates:report'), a), args)
}

async function main() {
  const secret = process.env.UPDATER_SECRET
  if (!secret) fail('UPDATER_SECRET is not set')
  const [command, arg] = process.argv.slice(2)
  try {
    if (command === 'watch') await watch(arg, secret)
    else if (command === 'report') await report(secret)
    else fail('usage: updater-agent.mjs watch <seconds> | report')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

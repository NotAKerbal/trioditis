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
//     UPDATER_MESSAGE, UPDATER_DONE, UPDATER_CURRENT and UPDATER_CURRENT_AT, and
//     UPDATER_LATEST_CHANNEL, UPDATER_LATEST, UPDATER_LATEST_AT, UPDATER_LATEST_SUBJECT,
//     UPDATER_BEHIND, UPDATER_AHEAD and UPDATER_CHECKED_AT. Times are Unix seconds.
//
// It exits 0 on success and 1 on any failure, with the reason on stderr.

import { createRequire } from 'node:module'

const backend = createRequire('/repo/packages/backend/package.json')
const { ConvexClient, ConvexHttpClient } = backend('convex/browser')
const { makeFunctionReference } = backend('convex/server')

// The backend's service on the bundle's network, as in compose.yml.
const url = process.env.CONVEX_URL || 'http://backend:3210'
const secret = process.env.UPDATER_SECRET
if (!secret) fail('UPDATER_SECRET is not set')

const CHANNELS = new Set(['stable', 'nightly'])
const KINDS = new Set(['check', 'update'])
// What a request ID may be (randomToken in packages/backend/convex/lib/hash.ts), so the line
// printed always splits into exactly four words.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

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

async function watch(seconds) {
  if (!/^[0-9]{1,5}$/.test(seconds ?? '')) fail('watch takes a number of seconds')
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

function seconds(name) {
  const value = process.env[name]
  if (!/^[0-9]{1,12}$/.test(value ?? '')) fail(`${name} must be Unix seconds`)
  return Number(value) * 1000
}

function count(name) {
  const value = process.env[name]
  if (!/^[0-9]{1,9}$/.test(value ?? '')) fail(`${name} must be a count`)
  return Number(value)
}

async function report() {
  const env = process.env
  const args = { secret, state: env.UPDATER_STATE }
  if (env.UPDATER_MESSAGE) args.message = env.UPDATER_MESSAGE
  if (env.UPDATER_DONE) args.done = env.UPDATER_DONE
  if (env.UPDATER_CURRENT) {
    args.current = { commit: env.UPDATER_CURRENT, committedAt: seconds('UPDATER_CURRENT_AT') }
  }
  if (env.UPDATER_LATEST) {
    args.latest = {
      channel: env.UPDATER_LATEST_CHANNEL,
      commit: env.UPDATER_LATEST,
      committedAt: seconds('UPDATER_LATEST_AT'),
      subject: env.UPDATER_LATEST_SUBJECT ?? '',
      behind: count('UPDATER_BEHIND'),
      ahead: count('UPDATER_AHEAD'),
      checkedAt: seconds('UPDATER_CHECKED_AT'),
    }
  }
  await new ConvexHttpClient(url).mutation(makeFunctionReference('updates:report'), args)
}

const [command, arg] = process.argv.slice(2)
try {
  if (command === 'watch') await watch(arg)
  else if (command === 'report') await report()
  else fail('usage: updater-agent.mjs watch <seconds> | report')
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

// Starts a working local instance of this checkout: its own Convex backend running on this
// machine, the gateway, a bridge host for each network, and the web app once apps/desktop
// exists.
//
//   pnpm dev                       set up if needed, then start, with the fake network
//   pnpm dev --network whatsapp    a real WhatsApp bridge host instead (needs your phone)
//   pnpm dev --network fake,whatsapp
//   pnpm dev --setup               set up and stop; run for each new worktree
//
// Every checkout of the repository, the main one and each git worktree, has its own backend,
// data and ports, so branches run side by side without touching each other (scripts/lib.mjs,
// `portsFor`). The backend is a Convex local deployment that needs no Convex account: its data
// lives in packages/backend/.convex/local, and everything else this instance keeps (secrets,
// bridge host databases) in .data/. Git ignores both.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TESTER,
  backendDir,
  bridgeDir,
  buildBridgeHost,
  capture,
  claimSlot,
  convex,
  dataDir,
  desktopPackage,
  devSecrets,
  ensureTester,
  gatewayDir,
  localConvex,
  portsFor,
  root,
  run,
  start,
  step,
  stopGroup,
  waitFor,
  writeDevEnv,
} from './lib.mjs'

const NETWORKS = ['fake', 'whatsapp']

const args = process.argv.slice(2)
const setupOnly = args.includes('--setup')
const networkArg =
  args.find((arg, i) => args[i - 1] === '--network') ?? args.find((arg) => arg.startsWith('--network='))?.split('=')[1]
const networks = (networkArg ?? 'fake')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
for (const name of networks) {
  if (!NETWORKS.includes(name)) {
    console.error(`"${name}" isn't a network the dev stack can run. Choose from: ${NETWORKS.join(', ')}`)
    process.exit(1)
  }
}

const slot = await claimSlot()
const ports = portsFor(slot)
const web = desktopPackage()
const convexUrl = `http://127.0.0.1:${ports.convexCloud}`
const convexSiteUrl = `http://127.0.0.1:${ports.convexSite}`
// Sign-in's address: the web app's when there is one (it is where people sign in), otherwise
// the backend's own, where tools and scripts call Better Auth directly.
const siteUrl = web ? `http://localhost:${ports.web}` : convexSiteUrl
const portArgs = ['--local-cloud-port', String(ports.convexCloud), '--local-site-port', String(ports.convexSite)]
const hasBridgeHost = existsSync(resolve(bridgeDir, 'go.mod'))
const hostId = (network) => `${network}-1`
const bridgeAddr = (network) => `127.0.0.1:${ports.bridge[network]}`

const secrets = devSecrets()
const instance = {
  ...secrets,
  CONVEX_URL: convexUrl,
  CONVEX_SITE_URL: convexSiteUrl,
  SITE_URL: siteUrl,
  GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
  GATEWAY_INTERNAL_ADDR: `127.0.0.1:${ports.gateway}`,
  BRIDGE_HOSTS: networks.map((network) => `${hostId(network)}=http://${bridgeAddr(network)}`).join(','),
  BRIDGE_FAKE_CONTROL_ADDR: `127.0.0.1:${ports.fakeControl}`,
  TRIODITIS_NETWORKS: networks.join(','),
}
writeDevEnv(instance)

function backendPorts() {
  try {
    return JSON.parse(readFileSync(resolve(backendDir, '.convex/local/default/config.json'), 'utf8')).ports
  } catch {
    return null
  }
}

function isConfigured() {
  const current = backendPorts()
  const envFile = resolve(backendDir, '.env.local')
  return (
    current?.cloud === ports.convexCloud &&
    current?.site === ports.convexSite &&
    existsSync(envFile) &&
    /^CONVEX_DEPLOYMENT=anonymous:/m.test(readFileSync(envFile, 'utf8'))
  )
}

if (!isConfigured()) {
  step(`Creating a local backend for this checkout on ports ${ports.convexCloud} and ${ports.convexSite}`)
  run('pnpm', convex('dev', '--once', '--typecheck', 'disable', '--tail-logs', 'disable', ...portArgs), localConvex)
}

step('Checking backend settings')
const forConvex = {
  SITE_URL: siteUrl,
  BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
  GATEWAY_SECRET: secrets.GATEWAY_SECRET,
  TRIODITIS_SETUP_TOKEN: secrets.TRIODITIS_SETUP_TOKEN,
  TRIODITIS_NETWORKS: instance.TRIODITIS_NETWORKS,
  BRIDGE_PUBLIC_KEY: secrets.BRIDGE_PUBLIC_KEY,
  AGENT_ACCESS_PUBLIC_KEY: secrets.AGENT_ACCESS_PUBLIC_KEY,
}
const existing = new Map(
  capture('pnpm', convex('env', 'list'), { ...localConvex, quiet: true })
    .split('\n')
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
)
for (const [name, value] of Object.entries(forConvex)) {
  if (existing.get(name) === value) continue
  capture('pnpm', convex('env', 'set', name, value), { ...localConvex, quiet: true })
  console.log(`Set ${name}.`)
}

if (hasBridgeHost) {
  step('Building the bridge host')
  buildBridgeHost()
}

const children = []
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) stopGroup(child)
  // Give each a moment to shut down cleanly, then make sure.
  setTimeout(() => {
    for (const child of children) stopGroup(child, 'SIGKILL')
    process.exit(code)
  }, 3000).unref()
  void Promise.all(
    children.map((child) => new Promise((done) => (child.exitCode !== null ? done() : child.once('exit', done)))),
  ).then(() => process.exit(code))
}
function launch(name, cmd, cmdArgs, options) {
  const child = start(name, cmd, cmdArgs, options)
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n${name} stopped (exit code ${code ?? 'none'}). Stopping the rest.`)
      stop(code || 1)
    }
  })
  children.push(child)
  return child
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

step('Starting the backend')
const backend = launch('convex', 'pnpm', convex('dev', '--typecheck', 'disable', ...portArgs), localConvex)
// The CLI reports each push on stderr. Until the first push of this run, the backend may still
// be serving the functions an earlier run pushed.
const pushed = new Promise((resolvePushed) => {
  for (const stream of [backend.stdout, backend.stderr]) {
    stream.on('data', (chunk) => String(chunk).includes('Convex functions ready') && resolvePushed())
  }
})

try {
  await waitFor(`${convexSiteUrl}/api/auth/ok`, 120)
  await Promise.race([
    pushed,
    new Promise((_, fail) =>
      setTimeout(() => fail(new Error('The backend’s functions were not pushed within 3 minutes.')), 180_000),
    ),
  ])
  step('Creating the test account')
  await ensureTester({ authUrl: convexSiteUrl, origin: siteUrl, setupToken: secrets.TRIODITIS_SETUP_TOKEN })
} catch (error) {
  console.error(`\n${error.message}`)
  stop(1)
}

if (stopping) {
  // Stopping after a failure above: nothing else starts.
} else if (setupOnly) {
  console.log(`\n\x1b[1mSet up.\x1b[0m Run \`pnpm dev\` to start Trioditis for this checkout.`)
  stop(0)
} else {
  step('Starting the gateway')
  launch('gateway', 'node', ['--watch', 'src/main.ts'], {
    cwd: gatewayDir,
    env: {
      CONVEX_URL: convexUrl,
      GATEWAY_SECRET: secrets.GATEWAY_SECRET,
      TRIODITIS_INTERNAL_TOKEN: secrets.TRIODITIS_INTERNAL_TOKEN,
      GATEWAY_INTERNAL_ADDR: instance.GATEWAY_INTERNAL_ADDR,
      AGENT_ACCESS_PUBLIC_KEY: secrets.AGENT_ACCESS_PUBLIC_KEY,
      BRIDGE_HOSTS: instance.BRIDGE_HOSTS,
    },
  })
  await waitFor(`${instance.GATEWAY_URL}/healthz`, 30).catch(() => {})

  if (hasBridgeHost) {
    for (const network of networks) {
      step(`Starting the ${network} bridge host`)
      launch(`bridge:${network}`, resolve(bridgeDir, 'bin/bridge-host'), ['--network', network, 'run'], {
        cwd: root,
        env: {
          GATEWAY_URL: instance.GATEWAY_URL,
          TRIODITIS_INTERNAL_TOKEN: secrets.TRIODITIS_INTERNAL_TOKEN,
          BRIDGE_PUBLIC_KEY: secrets.BRIDGE_PUBLIC_KEY,
          BRIDGE_PRIVATE_KEY: secrets.BRIDGE_PRIVATE_KEY,
          BRIDGE_HOST_ID: hostId(network),
          BRIDGE_HOST_ADDR: bridgeAddr(network),
          BRIDGE_DATA_DIR: resolve(dataDir, `bridge-${network}`),
          ...(network === 'fake' ? { BRIDGE_FAKE_CONTROL_ADDR: instance.BRIDGE_FAKE_CONTROL_ADDR } : {}),
        },
      })
    }
  } else {
    console.log('\nNo bridge host in this checkout (apps/bridge-host): networks are not bridged.')
  }

  if (web) {
    step('Starting the web app')
    // apps/desktop's dev server takes its port from PORT and proxies sign-in (/api/auth) and
    // the MCP server to VITE_CONVEX_SITE_URL, so the browser signs in on the page's own origin,
    // the SITE_URL set above, as it does behind Caddy and on Vercel.
    launch('web', 'pnpm', ['--filter', web.name, 'run', 'dev'], {
      env: {
        PORT: String(ports.web),
        VITE_CONVEX_URL: convexUrl,
        VITE_CONVEX_SITE_URL: convexSiteUrl,
        VITE_TRIODITIS_ENVIRONMENT: 'development',
      },
    })
    await waitFor(siteUrl, 120).catch(() => {})
  }

  console.log(`
\x1b[1mTrioditis is running\x1b[0m
  URL        ${web ? siteUrl : `${siteUrl} (no web app in this checkout yet: apps/desktop)`}
  Email      ${TESTER.email}
  Password   ${TESTER.password}
  Networks   ${networks.join(', ')}${networks.includes('fake') ? `  (pnpm fake <username> <from> "<text>" delivers a message)` : ''}
  Data       packages/backend/.convex/local and .data/, this checkout only

Ctrl+C stops everything.`)
}

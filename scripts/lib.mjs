// Shared helpers for the repo scripts: running commands, the per-checkout dev instance's
// ports and secrets, the test account, and the accounts previews and nightly deploy to.
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { homedir } from 'node:os'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const backendDir = resolve(root, 'packages/backend')
export const gatewayDir = resolve(root, 'apps/gateway')
export const bridgeDir = resolve(root, 'apps/bridge-host')
export const desktopDir = resolve(root, 'apps/desktop')
/** Everything a checkout's dev instance keeps: secrets, ports, bridge host data. Git ignores it. */
export const dataDir = resolve(root, '.data')

/**
 * The Convex team and project, and the Vercel account and project, that previews and nightly
 * deploy to. Every script reads them from here, so moving accounts changes only this,
 * `environments` below and docs/CONTRIBUTING.md ("Previews" and "Nightly").
 *
 * Nothing exists on either service yet: the `null`s are filled in once Isaac has created the
 * Vercel project and the nightly Convex deployment (docs/CONTRIBUTING.md, "Setting it up").
 * Until then `pnpm preview` and the nightly build stop and say what is missing.
 */
export const accounts = {
  convexTeam: 'isaac-cochran',
  convexProject: 'trioditis',
  vercelScope: 'notakerbals-projects',
  vercelOrgId: null,
  vercelWebProjectId: null, // trioditis-web
}

/** A deployment in the Convex project, such as `convexRef('preview/my-branch')`. */
export const convexRef = (deployment) => `${accounts.convexTeam}:${accounts.convexProject}:${deployment}`

/**
 * The one long-lived Vercel site: a push to `dev` deploys nightly, a demo-only instance. There
 * is no production site on Vercel: production is a self-hosted server (deploy/).
 */
export const environments = {
  nightly: { siteUrl: null, deployment: null },
}

/**
 * The only networks a backend on Convex's cloud (a preview or nightly) may offer. Their data is
 * made up, so real accounts and real messages never reach the cloud.
 */
export const CLOUD_NETWORKS = 'fake'

// Every dev instance, preview and nightly gets this account, so there is something to sign in
// with straight away. Those backends hold throwaway data only.
export const TESTER = { name: 'Dev Tester', email: 'tester@trioditis.test', password: 'trioditis-dev-tester' }

export function env(extra = {}) {
  return { ...process.env, ...extra }
}

/**
 * Names a command for an error message without its later arguments, which can hold secrets
 * such as a generated key being passed to `convex env set`.
 */
function describe(cmd, args) {
  const shown = args.slice(0, 4).join(' ')
  return `${cmd} ${shown}${args.length > 4 ? ' …' : ''}`
}

/** Runs a command to completion and returns its trimmed stdout. Throws on failure. */
export function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? root,
    env: env(options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`${describe(cmd, args)} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.quiet ? `\n${result.stderr}` : ''
    throw new Error(`${describe(cmd, args)} failed with exit code ${result.status}${detail}`)
  }
  return result.stdout.trim()
}

/** Runs a command with its output shown. Throws on failure. */
export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: options.cwd ?? root, env: env(options.env), stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${describe(cmd, args)} failed with exit code ${result.status}`)
}

/**
 * Starts a long-running command in its own process group, with each line of its output
 * prefixed by `name`, so several processes can share one terminal and all of one's children
 * can be stopped together.
 */
export function start(name, cmd, args, options = {}) {
  const child = spawn(cmd, args, {
    cwd: options.cwd ?? root,
    env: env(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const label = `\x1b[2m${name.padEnd(options.width ?? 12)}\x1b[0m│ `
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) process.stdout.write(`${label}${line}\n`)
    })
    stream.on('end', () => pending && process.stdout.write(`${label}${pending}\n`))
  }
  return child
}

/** Stops a process started with `start`, and everything it started. */
export function stopGroup(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // Already gone.
  }
}

export function step(message) {
  console.log(`\n\x1b[1m▸ ${message}\x1b[0m`)
}

export function isFree(port) {
  return new Promise((done) => {
    const server = createServer()
      .once('error', () => done(false))
      .listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

export async function waitFor(url, seconds, { ok = (response) => response.ok } = {}) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (ok(await fetch(url))) return
    } catch {}
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new Error(`${url} did not respond within ${seconds} seconds.`)
}

/**
 * Checkout n's ports. The main checkout is slot 0; each worktree claims the next free slot the
 * first time and keeps it. They are kept clear of Convex's defaults (3210/3211), so a backend
 * started by hand never takes a checkout's ports.
 */
export const portsFor = (slot) => ({
  web: 5180 + slot,
  convexCloud: 4210 + 2 * slot,
  convexSite: 4211 + 2 * slot,
  gateway: 8700 + 10 * slot,
  bridge: { fake: 8701 + 10 * slot, whatsapp: 8702 + 10 * slot },
  fakeControl: 8709 + 10 * slot,
})

const instanceFile = (checkout) => resolve(checkout, '.data/dev.json')

function readInstance(checkout) {
  try {
    return JSON.parse(readFileSync(instanceFile(checkout), 'utf8'))
  } catch {
    return null
  }
}

/** This checkout's slot: the one it already has, or the first no other checkout has claimed. */
export async function claimSlot() {
  const own = readInstance(root)
  if (own) return own.slot
  const [main, ...worktrees] = capture('git', ['worktree', 'list', '--porcelain'], { quiet: true })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
  const claimed = new Set([main, ...worktrees].filter((path) => path !== root).map(readInstance).filter(Boolean).map((i) => i.slot))
  for (let slot = main === root ? 0 : 1; slot < 100; slot++) {
    if (claimed.has(slot)) continue
    const ports = portsFor(slot)
    const all = [ports.web, ports.convexCloud, ports.convexSite, ports.gateway, ...Object.values(ports.bridge), ports.fakeControl]
    if ((await Promise.all(all.map(isFree))).every(Boolean)) {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(instanceFile(root), JSON.stringify({ slot }, null, 2) + '\n')
      return slot
    }
  }
  throw new Error('Every dev slot is taken by another checkout or program.')
}

const secret = () => randomBytes(32).toString('base64url')

/** An X25519 key pair, base64url, the format packages/crypto and the bridge host use. */
export function x25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey: privateKey.export({ format: 'jwk' }).d }
}

function parseEnv(text) {
  const values = new Map()
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) values.set(match[1], match[2])
  }
  return values
}

/**
 * This checkout's secrets, generated once into .data/dev.env (readable only by you) and kept:
 * the bridge key and the opaque IDs derived from it must stay the same across runs.
 */
export function devSecrets() {
  const file = resolve(dataDir, 'dev.env')
  const values = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : new Map()
  const defaults = {
    BETTER_AUTH_SECRET: secret,
    GATEWAY_SECRET: secret,
    TRIODITIS_INTERNAL_TOKEN: secret,
    TRIODITIS_SETUP_TOKEN: secret,
  }
  for (const [name, make] of Object.entries(defaults)) if (!values.has(name)) values.set(name, make())
  for (const name of ['BRIDGE', 'AGENT_ACCESS']) {
    if (values.has(`${name}_PUBLIC_KEY`) && values.has(`${name}_PRIVATE_KEY`)) continue
    const pair = x25519()
    values.set(`${name}_PUBLIC_KEY`, pair.publicKey)
    values.set(`${name}_PRIVATE_KEY`, pair.privateKey)
  }
  return Object.fromEntries(values)
}

/** Writes .data/dev.env: the secrets plus this instance's addresses, for the dev scripts and tools. */
export function writeDevEnv(values) {
  mkdirSync(dataDir, { recursive: true })
  const file = resolve(dataDir, 'dev.env')
  writeFileSync(file, Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Runs the Convex CLI in packages/backend against this checkout's local backend. */
export const convex = (...args) => ['exec', 'convex', ...args]
export const localConvex = { cwd: backendDir, env: { CONVEX_AGENT_MODE: 'anonymous' } }

/** The Go toolchain: on PATH, or where the dev VM keeps it. */
export function goEnv() {
  const local = resolve(homedir(), '.local/go/bin')
  const onPath = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0
  if (onPath) return {}
  if (existsSync(resolve(local, 'go'))) return { PATH: `${local}${delimiter}${process.env.PATH}` }
  throw new Error('Go 1.27 is needed for the bridge host: https://go.dev/dl/ (or put it in ~/.local/go)')
}

/** Builds the bridge host binary. Go's build cache makes this quick when nothing changed. */
export function buildBridgeHost() {
  run('go', ['build', '-o', 'bin/bridge-host', './cmd/bridge-host'], { cwd: bridgeDir, env: goEnv() })
  return resolve(bridgeDir, 'bin/bridge-host')
}

/** The desktop and web app's package, if this checkout has it and it can be run. */
export function desktopPackage() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8'))
    return pkg.scripts?.dev ? pkg : null
  } catch {
    return null
  }
}

/**
 * Creates the test account on a backend unless it is already there. The first account on a
 * server is its admin and needs the setup token; on a backend that already has an admin who
 * isn't the test account, it says so instead. Requests go to `authUrl` as if sent from `origin`.
 */
export async function ensureTester({ authUrl, origin, setupToken }) {
  const post = (path, body, headers = {}) =>
    fetch(`${authUrl}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
    })
  const signIn = await post('sign-in/email', { email: TESTER.email, password: TESTER.password })
  if (signIn.ok) {
    console.log('Already there from an earlier run.')
    return
  }
  const signUp = await post('sign-up/email', TESTER, { 'x-trioditis-invite': setupToken })
  if (signUp.ok) {
    console.log('Created, as the admin.')
    return
  }
  if (signUp.status === 403) {
    throw new Error(
      `This backend already has an admin, so the test account can't be created. Use that account, or throw this instance's data away (docs/CONTRIBUTING.md, "Starting over").`,
    )
  }
  throw new Error(`Creating the test account failed (${signUp.status}): ${await signUp.text()}`)
}

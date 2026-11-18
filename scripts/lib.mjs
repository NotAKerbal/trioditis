// Shared helpers for the repo scripts: running commands, the per-checkout dev instance's
// backend, ports and secrets, the test account, and the accounts previews and nightly deploy to.
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { homedir } from 'node:os'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const backendDir = resolve(root, 'packages/backend')
export const gatewayDir = resolve(root, 'apps/gateway')
export const bridgeDir = resolve(root, 'apps/bridge-host')
export const desktopDir = resolve(root, 'apps/desktop')
/** The desktop and web app's package (apps/desktop). */
export const DESKTOP_PACKAGE = '@trioditis/desktop'
/** Everything a checkout's dev instance keeps: secrets, ports, bridge host data. Git ignores it. */
export const dataDir = resolve(root, '.data')
/** State shared by every checkout on this machine: which checkout holds which dev slot. */
export const stateDir = resolve(process.env.XDG_STATE_HOME ?? resolve(homedir(), '.local/state'), 'trioditis')

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
 * is no production site on Vercel: production is a server people run themselves (deploy/).
 */
export const environments = {
  nightly: { siteUrl: null, deployment: null },
}

/**
 * The only networks a backend on Convex's cloud (a preview or nightly) may offer. Their data is
 * made up, so real accounts and real messages never reach the cloud.
 */
export const CLOUD_NETWORKS = 'fake'

// Every dev instance and preview gets this account, so there is something to sign in with
// straight away. Those backends hold throwaway data only. Nightly never gets it.
export const TESTER = { name: 'Dev Tester', email: 'tester@trioditis.test', password: 'trioditis-dev-tester' }

/** The environment for a child: ours, with `extra` added and the names in `unset` removed. */
export function env(extra = {}, unset = []) {
  const result = { ...process.env, ...extra }
  for (const name of unset) delete result[name]
  return result
}

/**
 * Names a command for an error message without its later arguments, which can hold secrets.
 */
function describe(cmd, args) {
  const shown = args.slice(0, 4).join(' ')
  return `${cmd} ${shown}${args.length > 4 ? ' …' : ''}`
}

/** Runs a command to completion and returns its trimmed stdout. Throws on failure. */
export function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? root,
    env: env(options.env, options.unset),
    encoding: 'utf8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', options.quiet ? 'pipe' : 'inherit'],
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
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? root,
    env: env(options.env, options.unset),
    stdio: 'inherit',
  })
  if (result.error) throw new Error(`${describe(cmd, args)} failed: ${result.error.message}`)
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
    env: env(options.env, options.unset),
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

/**
 * Stops a process started with `start` and everything in its process group: even after the
 * leader has exited, what it started can still be running.
 */
export function stopGroup(child, signal = 'SIGTERM') {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is gone.
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

const allPorts = (ports) => [
  ports.web,
  ports.convexCloud,
  ports.convexSite,
  ports.gateway,
  ...Object.values(ports.bridge),
  ports.fakeControl,
]

const slotsDir = resolve(stateDir, 'slots')
const slotLock = (slot) => resolve(slotsDir, `${slot}.lock`)
const instanceFile = resolve(dataDir, 'dev.json')

function lockHolder(slot) {
  try {
    return readFileSync(slotLock(slot), 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Takes a slot for this checkout, atomically: the lock file is created only if it doesn't
 * exist (O_EXCL), so two checkouts setting up at once can't both get it.
 */
function tryLock(slot) {
  mkdirSync(slotsDir, { recursive: true })
  let fd
  try {
    fd = openSync(slotLock(slot), 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  writeSync(fd, `${root}\n`)
  closeSync(fd)
  return true
}

/** Releases slots held by checkouts that no longer exist on this machine. */
function releaseStaleSlots() {
  if (!existsSync(slotsDir)) return
  for (const file of readdirSync(slotsDir)) {
    const holder = lockHolder(Number.parseInt(file, 10))
    if (holder && !existsSync(resolve(holder, '.git'))) rmSync(resolve(slotsDir, file), { force: true })
  }
}

/**
 * This checkout's slot. The one it saved is used only if its lock still names this checkout;
 * otherwise it takes the first free one. The main checkout's slot is 0; worktrees start at 1.
 */
export async function claimSlot() {
  releaseStaleSlots()
  let saved = null
  try {
    saved = JSON.parse(readFileSync(instanceFile, 'utf8')).slot
  } catch {}
  if (Number.isInteger(saved)) {
    if (lockHolder(saved) === root) return saved
    if (lockHolder(saved) === null && tryLock(saved)) return saved
    console.log(`Slot ${saved} now belongs to ${lockHolder(saved) ?? 'another checkout'}: taking a new one.`)
  }
  // A slot this checkout already holds but forgot (its .data/dev.json was deleted): take it back
  // rather than claim another and leave the old lock behind for good.
  const held = existsSync(slotsDir)
    ? readdirSync(slotsDir)
        .map((file) => Number.parseInt(file, 10))
        .filter((slot) => Number.isInteger(slot) && lockHolder(slot) === root)
        .sort((a, b) => a - b)
    : []
  if (held.length > 0) {
    for (const extra of held.slice(1)) rmSync(slotLock(extra), { force: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(instanceFile, JSON.stringify({ slot: held[0] }, null, 2) + '\n')
    return held[0]
  }
  const main = capture('git', ['worktree', 'list', '--porcelain'], { quiet: true })
    .split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length)
  for (let slot = main === root ? 0 : 1; slot < 100; slot++) {
    if (!tryLock(slot)) continue
    if (!(await Promise.all(allPorts(portsFor(slot)).map(isFree))).every(Boolean)) {
      rmSync(slotLock(slot), { force: true })
      continue
    }
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(instanceFile, JSON.stringify({ slot }, null, 2) + '\n')
    return slot
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
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = resolve(dataDir, 'dev.env')
  writeFileSync(
    file,
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  )
  chmodSync(file, 0o600)
}

export const convex = (...args) => ['exec', 'convex', ...args]

/**
 * The environment variables the Convex CLI reads to choose a deployment, or that point it at
 * one (convex 1.50, from its CLI source). Every one is removed for the local backend's commands,
 * so a `CONVEX_DEPLOY_KEY` or `CONVEX_DEPLOYMENT` in your shell can never send `pnpm dev`'s
 * pushes and settings to a cloud or shared backend. Any other `CONVEX_` variable goes too.
 */
const CONVEX_SELECTORS = [
  'CONVEX_DEPLOY_KEY',
  'CONVEX_DEPLOYMENT_TOKEN',
  'CONVEX_DEPLOYMENT',
  'CONVEX_URL',
  'CONVEX_SITE_URL',
  'CONVEX_CLOUD_URL',
  'CONVEX_SELF_HOSTED_URL',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'CONVEX_ACCOUNT',
  'CONVEX_OVERRIDE_ACCESS_TOKEN',
  'CONVEX_PROVISION_HOST',
]
export const localConvex = {
  cwd: backendDir,
  env: { CONVEX_AGENT_MODE: 'anonymous' },
  unset: [
    ...new Set([
      ...CONVEX_SELECTORS,
      ...Object.keys(process.env).filter((name) => name.startsWith('CONVEX_') && name !== 'CONVEX_AGENT_MODE'),
    ]),
  ],
}

/**
 * Refuses unless the Convex CLI, run in packages/backend, can only reach this checkout's own
 * local backend: `.env.local` (if any) names an anonymous local deployment, and no other dotenv
 * file there sets a `CONVEX_` variable. Checked before every push or settings change.
 */
export function assertLocalBackend({ requireConfigured = true, dir = backendDir } = {}) {
  const problems = []
  const envLocal = resolve(dir, '.env.local')
  if (existsSync(envLocal)) {
    const deployment = parseEnv(readFileSync(envLocal, 'utf8')).get('CONVEX_DEPLOYMENT')
    if (!deployment?.startsWith('anonymous:')) {
      problems.push(
        `packages/backend/.env.local names ${deployment ? `the deployment "${deployment}"` : 'no deployment'}, not this checkout's local backend`,
      )
    }
  } else if (requireConfigured) {
    problems.push('packages/backend/.env.local is missing')
  }
  for (const file of ['.env', '.env.development', '.env.development.local']) {
    const path = resolve(dir, file)
    if (existsSync(path) && /^CONVEX_/m.test(readFileSync(path, 'utf8')))
      problems.push(`packages/backend/${file} sets a CONVEX_ variable`)
  }
  if (requireConfigured && !existsSync(resolve(dir, '.convex/local/default/config.json'))) {
    problems.push('this checkout has no local backend in packages/backend/.convex/local')
  }
  if (problems.length > 0) {
    throw new Error(
      `pnpm dev only works with this checkout's own local backend, and won't touch any other:\n  - ${problems.join('\n  - ')}\n` +
        'Move those files aside, or start over (docs/CONTRIBUTING.md, "Starting over").',
    )
  }
}

/**
 * Sets variables on a backend through stdin, so their values never appear in a process list.
 * `options` says which backend (the Convex CLI's options and environment).
 */
export function setConvexEnv(values, options) {
  const entries = Object.entries(values)
  if (entries.length === 0) return
  capture(
    'pnpm',
    convex('env', 'set', '--force', ...(options.deployment ? ['--deployment', options.deployment] : [])),
    {
      ...options,
      quiet: true,
      input: entries.map(([name, value]) => `${name}=${value}`).join('\n') + '\n',
    },
  )
}

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

/** The desktop and web app's package, if this checkout has it. */
export function desktopPackage() {
  try {
    return JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * What a deploy to Convex's cloud (a preview or nightly) needs from this checkout, as a list
 * of what's missing: the web app and its build, and the backend's demo and key functions.
 * Checked before anything is created or changed in the cloud.
 */
export function cloudPrerequisites() {
  const missing = []
  const desktop = desktopPackage()
  if (!desktop) missing.push(`the web app (${DESKTOP_PACKAGE} in apps/desktop)`)
  else if (desktop.name !== DESKTOP_PACKAGE)
    missing.push(`apps/desktop is named ${desktop.name}, not ${DESKTOP_PACKAGE}`)
  else if (!desktop.scripts?.build) missing.push(`a build script in apps/desktop/package.json`)
  const source = (file) => {
    try {
      return readFileSync(resolve(backendDir, 'convex', file), 'utf8')
    } catch {
      return ''
    }
  }
  // The client API (api/client-contract): the key setup and demo data the test account uses.
  if (!/export const seedForMe\b/.test(source('demo.ts'))) {
    missing.push('the backend function demo.seedForMe (the client API, api/client-contract)')
  }
  if (!/export const setup\b/.test(source('keys.ts')) || !/export const identity\b/.test(source('keys.ts'))) {
    missing.push('the backend functions keys.setup and keys.identity (the client API, api/client-contract)')
  }
  return missing
}

/**
 * The password the app sends when someone signs in with `typed`: derived by packages/crypto's
 * `authPassword` once it has one (the client API work), so the typed password, which also
 * unlocks their key backup, never reaches the server. Until then, the typed password itself.
 */
export async function signInPassword(typed, email) {
  const crypto = await import('@trioditis/crypto')
  if (typeof crypto.authPassword !== 'function') return typed
  // All of packages/crypto is synchronous once libsodium has loaded.
  await crypto.ready()
  return crypto.authPassword(typed, email)
}

/**
 * Creates the test account on a backend unless it is already there, and returns its user ID.
 * The first account on a server is its admin and needs the setup token; on a backend that
 * already has an admin who isn't the test account, it says so instead. Requests go to
 * `authUrl` as if sent from `origin`. `password` is what the app sends at sign-in.
 */
export async function ensureTester({ authUrl, origin, setupToken, password = TESTER.password }) {
  const post = (path, body, headers = {}) =>
    fetch(`${authUrl}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
    })
  const signIn = await post('sign-in/email', { email: TESTER.email, password })
  if (signIn.ok) {
    console.log('Already there from an earlier run.')
    return (await signIn.json()).user.id
  }
  // A test account made before sign-in derived its password (authPassword) still has the typed
  // one: sign in with that and move it to the derived password, as the app now sends.
  if (password !== TESTER.password) {
    const legacy = await post('sign-in/email', { email: TESTER.email, password: TESTER.password })
    if (legacy.ok) {
      const cookie = legacy.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
      const changed = await post(
        'change-password',
        { currentPassword: TESTER.password, newPassword: password, revokeOtherSessions: true },
        { cookie },
      )
      if (!changed.ok) throw new Error(`Updating the test account's password failed (${changed.status}).`)
      console.log('Already there from an earlier run; moved it to the derived password.')
      return (await legacy.json()).user.id
    }
  }
  const signUp = await post('sign-up/email', { ...TESTER, password }, { 'x-trioditis-invite': setupToken })
  if (signUp.ok) {
    console.log('Created, as the admin.')
    return (await signUp.json()).user.id
  }
  if (signUp.status === 403) {
    throw new Error(
      `This backend already has an admin who isn't the test account. Sign in as that admin, or start this checkout's backend over with "pnpm dev --setup --reset" (docs/CONTRIBUTING.md, "Starting over").`,
    )
  }
  throw new Error(`Creating the test account failed (${signUp.status}): ${await signUp.text()}`)
}

/**
 * Holds a lock named `name` for as long as this process runs, so two runs of the same thing
 * (`pnpm preview <name>`) can't overlap. A lock left by a process that died is taken over.
 */
export function holdLock(name) {
  const dir = resolve(stateDir, 'locks')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${name}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      process.on('exit', () => rmSync(path, { force: true }))
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const pid = Number.parseInt(readFileSync(path, 'utf8'), 10)
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {}
      if (alive) throw new Error(`Another run (process ${pid}) holds ${name}. Wait for it to finish.`)
      rmSync(path, { force: true })
    }
  }
  throw new Error(`Could not take the lock ${name}.`)
}

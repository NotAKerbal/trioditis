// Shared helpers for the repo scripts: running commands, the per-checkout dev instance's
// backend, ports and secrets, the test account, and the accounts previews and nightly deploy to.
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, resolve, sep } from 'node:path'
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

/**
 * Waits until `url` answers as `ok` wants, for at most `seconds` in all. Each request gets its
 * own short timeout, so a server that accepts the connection and never answers can't hold the
 * wait past its limit.
 */
export async function waitFor(url, seconds, { ok = (response) => response.ok } = {}) {
  const deadline = Date.now() + seconds * 1000
  for (let left = seconds * 1000; left > 0; left = deadline - Date.now()) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, left)) })
      const answered = ok(response)
      // Free the connection: only the status was wanted.
      await response.body?.cancel().catch(() => {})
      if (answered) return
    } catch {}
    const pause = Math.min(1000, deadline - Date.now())
    if (pause > 0) await new Promise((done) => setTimeout(done, pause))
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
const slotLockName = /^(\d+)\.lock$/
const instanceFile = resolve(dataDir, 'dev.json')

/** `.data`, created readable only by you: it holds this checkout's secrets and bridge logins. */
export function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
}

function readLock(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Creates the lock at `path` naming `holder`, only if there is none (O_EXCL), so two processes
 * can't both get it. Until `holder` is written the file is empty, which every reader takes to
 * mean it is held.
 */
function createLock(path, holder) {
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  writeSync(fd, `${holder}\n`)
  closeSync(fd)
  return true
}

/**
 * Removes the lock at `path` if its holder is gone (`isStale`), without ever removing a lock
 * that took its place. Two processes can both read the same stale holder; if both then removed
 * the file, the second would remove the lock the first had just taken. So removal happens under
 * a guard file created with O_EXCL, and the holder is read again under it: only a guard holder
 * removes another's lock, so the lock can't change between that read and the removal.
 *
 * A guard is held for a few system calls. One left behind by a run that was killed in between
 * stops that lock from being released automatically, and the message says which file to delete.
 * `beforeGuard` is for tests, to run another process's steps between the two reads.
 */
export function removeStaleLock(path, isStale, { beforeGuard } = {}) {
  const stale = (holder) => holder !== null && holder !== '' && isStale(holder)
  if (!stale(readLock(path))) return false
  beforeGuard?.()
  const guardDir = resolve(dirname(path), 'releasing')
  const guard = resolve(guardDir, basename(path))
  mkdirSync(guardDir, { recursive: true, mode: 0o700 })
  if (!createLock(guard, process.pid)) {
    const pid = readLock(guard)
    if (pid !== '' && !processAlive(pid)) {
      console.warn(`${guard} was left by a run that stopped while releasing ${path}. Delete it to release that lock.`)
    }
    return false
  }
  try {
    if (!stale(readLock(path))) return false
    rmSync(path, { force: true })
    return true
  } finally {
    rmSync(guard, { force: true })
  }
}

function processAlive(text) {
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, as another user's process.
    return error.code === 'EPERM'
  }
}

/** A slot lock's holder is a checkout; it is gone when that checkout no longer exists. */
const checkoutGone = (holder) => !existsSync(resolve(holder, '.git'))

/** Who holds slot `slot`: the checkout its lock names, or null. */
export const slotHolder = (slot, dir = slotsDir) => readLock(resolve(dir, `${slot}.lock`))

/** Takes slot `slot` for `owner`, atomically; false if another checkout holds it. */
export function takeSlot(slot, owner = root, dir = slotsDir) {
  mkdirSync(dir, { recursive: true })
  return createLock(resolve(dir, `${slot}.lock`), owner)
}

/** Releases slots held by checkouts that no longer exist on this machine. */
export function releaseStaleSlots(dir = slotsDir, options = {}) {
  if (!existsSync(dir)) return
  for (const file of readdirSync(dir)) {
    if (slotLockName.test(file)) removeStaleLock(resolve(dir, file), checkoutGone, options)
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
    if (slotHolder(saved) === root) return saved
    if (slotHolder(saved) === null && takeSlot(saved)) return saved
    console.log(`Slot ${saved} now belongs to ${slotHolder(saved) || 'another checkout'}: taking a new one.`)
  }
  const save = (slot) => {
    ensureDataDir()
    writeFileSync(instanceFile, JSON.stringify({ slot }, null, 2) + '\n')
    return slot
  }
  // A slot this checkout already holds but forgot (its .data/dev.json was deleted): take it back
  // rather than claim another and leave the old lock behind for good.
  const held = existsSync(slotsDir)
    ? readdirSync(slotsDir)
        .map((file) => file.match(slotLockName)?.[1])
        .filter((slot) => slot !== undefined && slotHolder(slot) === root)
        .map(Number)
        .sort((a, b) => a - b)
    : []
  if (held.length > 0) {
    for (const extra of held.slice(1)) rmSync(resolve(slotsDir, `${extra}.lock`), { force: true })
    return save(held[0])
  }
  const main = capture('git', ['worktree', 'list', '--porcelain'], { quiet: true })
    .split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length)
  for (let slot = main === root ? 0 : 1; slot < 100; slot++) {
    if (!takeSlot(slot)) continue
    if (!(await Promise.all(allPorts(portsFor(slot)).map(isFree))).every(Boolean)) {
      rmSync(resolve(slotsDir, `${slot}.lock`), { force: true })
      continue
    }
    return save(slot)
  }
  throw new Error('Every dev slot is taken by another checkout or program.')
}

/**
 * Removes `path`, which must be in this checkout (`top`), never anything a symlink leads to
 * outside it: the directory it is in must really be inside the checkout, and a symlink at
 * `path` itself is removed, not what it points to.
 */
export function removeFromCheckout(path, top = root) {
  let parent
  try {
    parent = realpathSync(dirname(path))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const inside = realpathSync(top)
  if (parent !== inside && !parent.startsWith(inside + sep)) {
    throw new Error(`${path} is reached through a link to ${parent}, outside this checkout: not deleting it.`)
  }
  const target = resolve(parent, basename(path))
  let link
  try {
    link = lstatSync(target).isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  // A link is removed itself. Inside a directory, rmSync removes links without following them.
  rmSync(target, { recursive: !link, force: true })
}

const secret = () => randomBytes(32).toString('base64url')

/** An X25519 key pair, base64url, the format packages/crypto and the bridge host use. */
export function x25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey: privateKey.export({ format: 'jwk' }).d }
}

/**
 * Parses a dotenv file exactly as dotenv 16.6.1 does (its `parse`), the version the Convex CLI
 * bundles, so what is checked here is what the CLI would read: an `export ` prefix, `KEY: value`,
 * quotes (with `\\n` expanded in double quotes), comments and blank lines. Later lines win.
 */
export function parseDotenv(text) {
  const line =
    /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm
  const values = {}
  const lines = text.replace(/\r\n?/gm, '\n')
  let match
  while ((match = line.exec(lines)) !== null) {
    let value = (match[2] || '').trim()
    const quote = value[0]
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2')
    if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    values[match[1]] = value
  }
  return values
}

/**
 * This checkout's secrets, generated once into .data/dev.env (readable only by you) and kept:
 * the bridge key and the opaque IDs derived from it must stay the same across runs.
 */
export function devSecrets() {
  const file = resolve(dataDir, 'dev.env')
  const values = new Map(existsSync(file) ? Object.entries(parseDotenv(readFileSync(file, 'utf8'))) : [])
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
  ensureDataDir()
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
      // With DOTENV_KEY set, dotenv reads an encrypted .env.local.vault or .env.vault instead.
      'DOTENV_KEY',
      ...Object.keys(process.env).filter((name) => name.startsWith('CONVEX_') && name !== 'CONVEX_AGENT_MODE'),
    ]),
  ],
}

/**
 * The dotenv files the Convex CLI (1.50) loads from the directory it runs in, in that order, the
 * first to set a name winning (`loadProjectEnvironmentVariables` in its lib/envvars.js, and
 * `getAccountSelection` for CONVEX_ACCOUNT). It reads no others.
 */
const CONVEX_DOTENV_FILES = ['.env.local', '.env']

/** Where the CLI writes a local deployment's own addresses in .env.local. */
const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/

/**
 * Every name a line of `text` looks like it assigns, in dotenv's syntax or close to it. Checked
 * as well as what dotenv parses, so a line dotenv reads differently than expected can't hide one.
 */
const assignedNames = (text) =>
  [...text.matchAll(/^[^\S\n]*(?:export[^\S\n]+)?([\w.-]+)[^\S\n]*[=:]/gm)].map((match) => match[1])

/**
 * Refuses unless the Convex CLI, run in `dir` (packages/backend), can only reach this checkout's
 * own local backend. The CLI loads .env.local and .env into its environment, and a deploy key
 * there overrides any CONVEX_DEPLOYMENT, so neither file may set a CONVEX_ variable except, in
 * .env.local, what the CLI itself writes for a local anonymous deployment: CONVEX_DEPLOYMENT
 * naming this checkout's (the one in .convex/local), and CONVEX_URL and CONVEX_SITE_URL on this
 * machine. Checked before every push or settings change.
 */
export function assertLocalBackend({ requireConfigured = true, dir = backendDir } = {}) {
  const problems = []
  let local = null
  try {
    local = JSON.parse(readFileSync(resolve(dir, '.convex/local/default/config.json'), 'utf8'))
  } catch {}
  const ours = local?.deploymentName ? `anonymous:${local.deploymentName}` : null
  const allowed = {
    CONVEX_DEPLOYMENT: (value) =>
      /^anonymous:anonymous-[\w-]+$/.test(value) && (ours === null || value === ours)
        ? null
        : `names the deployment "${value}", not this checkout's local backend`,
    CONVEX_URL: (value) => (LOOPBACK_URL.test(value) ? null : `sets CONVEX_URL to ${value}, not this machine`),
    CONVEX_SITE_URL: (value) =>
      LOOPBACK_URL.test(value) ? null : `sets CONVEX_SITE_URL to ${value}, not this machine`,
  }
  for (const file of CONVEX_DOTENV_FILES) {
    const path = resolve(dir, file)
    if (existsSync(`${path}.vault`))
      problems.push(`packages/backend/${file}.vault exists, which dotenv can load instead`)
    if (!existsSync(path)) {
      if (file === '.env.local' && requireConfigured) problems.push('packages/backend/.env.local is missing')
      continue
    }
    const text = readFileSync(path, 'utf8')
    const values = parseDotenv(text)
    const names = new Set([...Object.keys(values), ...assignedNames(text)].filter((name) => /^convex_/i.test(name)))
    for (const name of names) {
      const check = file === '.env.local' ? allowed[name] : undefined
      const problem = check
        ? check(values[name] ?? '')
        : `sets ${name}, which can point the Convex CLI at another deployment`
      if (problem) problems.push(`packages/backend/${file} ${problem}`)
    }
    if (file === '.env.local' && !values.CONVEX_DEPLOYMENT) {
      problems.push("packages/backend/.env.local names no deployment, not this checkout's local backend")
    }
  }
  if (requireConfigured && local === null) {
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
 * Holds a lock named `name`, in `dir`, for as long as this process runs, so two runs of the same
 * thing (`pnpm preview <name>`, a checkout's `pnpm dev`) can't overlap. A lock left by a process
 * that died is taken over. `busy` says what to tell someone when a live process holds it.
 */
export function holdLock(name, { dir = resolve(stateDir, 'locks'), busy } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = resolve(dir, `${name}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createLock(path, process.pid)) {
      process.on('exit', () => {
        if (readLock(path) === String(process.pid)) rmSync(path, { force: true })
      })
      return path
    }
    if (removeStaleLock(path, (pid) => !processAlive(pid))) continue
    const pid = readLock(path)
    if (pid !== null) {
      throw new Error(
        busy?.(pid || 'starting') ?? `Another run (process ${pid || 'starting'}) holds ${name}. Wait for it to finish.`,
      )
    }
  }
  throw new Error(`Could not take the lock ${path}.`)
}

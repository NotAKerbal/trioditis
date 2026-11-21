// Shared helpers for the repo scripts: running commands, the per-checkout dev instance's
// backend, ports and secrets, the test account, and the accounts previews and nightly deploy to.
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
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
  // The gateway's public listener (the sign-in browser's viewers) and the login-browser
  // launcher, in the gaps the 8700s left.
  gatewayPublic: 8701 + 10 * slot,
  loginBrowser: 8703 + 10 * slot,
  bridge: {
    whatsapp: 8702 + 10 * slot,
    // The networks added later, above every slot's ports in the 8700s and 9000s (slots go
    // up to 99), so the ports above don't move.
    signal: 10101 + 20 * slot,
    gmessages: 10102 + 20 * slot,
    gvoice: 10103 + 20 * slot,
    telegram: 10104 + 20 * slot,
    meta: 10105 + 20 * slot,
    instagram: 10106 + 20 * slot,
    slack: 10107 + 20 * slot,
    groupme: 10108 + 20 * slot,
    linkedin: 10109 + 20 * slot,
    twitter: 10110 + 20 * slot,
    bluesky: 10111 + 20 * slot,
  },
})

const allPorts = (ports) => [
  ports.web,
  ports.convexCloud,
  ports.convexSite,
  ports.gateway,
  ports.gatewayPublic,
  ports.loginBrowser,
  ...Object.values(ports.bridge),
]

const slotsDir = resolve(stateDir, 'slots')
const slotLockName = /^(\d+)\.lock$/
const instanceFile = resolve(dataDir, 'dev.json')

/** `.data`, created readable only by you: it holds this checkout's secrets and bridge logins. */
export function ensureDataDir() {
  privateDir(dataDir)
}

/**
 * Makes `dir` if needed and leaves it readable only by you. It is opened with O_NOFOLLOW before
 * its mode is set, so a symlink there, even one made since it was checked, is refused rather
 * than followed.
 */
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR')
      throw new Error(`${dir} isn't a directory, or is a symlink: not writing there.`)
    throw error
  }
  try {
    fchmodSync(fd, 0o700)
  } finally {
    closeSync(fd)
  }
}

/**
 * Writes all of `path`, readable only by you, never through a symlink: into a new file beside
 * it (O_EXCL and O_NOFOLLOW), which is then renamed over it. A rename replaces a symlink at
 * `path` instead of following it, so a link made since the checks can't send the write anywhere.
 */
export function writePrivateFile(path, text) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, text)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
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
 * can't both get it. O_EXCL also refuses a symlink at `path`, so a lock is never written through one. Until `holder` is written the file is empty, which every reader takes to
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
 * Says what happened: `removed`; `kept` (its holder is there); `busy` (another process is
 * releasing it now); or `stuck`, when the guard was left by a run that was killed while holding
 * it. A guard is never removed automatically: a second process doing so could remove the guard
 * a third had just taken, and two would release at once again. So `stuck` stays until someone
 * deletes `guard`. `beforeGuard` is for tests, to run another process's steps between the reads.
 */
export function removeStaleLock(path, isStale, { beforeGuard } = {}) {
  const stale = (holder) => holder !== null && holder !== '' && isStale(holder)
  const guard = resolve(dirname(path), 'releasing', basename(path))
  if (!stale(readLock(path))) return { status: 'kept', guard }
  beforeGuard?.()
  mkdirSync(dirname(guard), { recursive: true, mode: 0o700 })
  if (!createLock(guard, process.pid)) return { status: guardAbandoned(guard) ? 'stuck' : 'busy', guard }
  try {
    if (!stale(readLock(path))) return { status: 'kept', guard }
    rmSync(path, { force: true })
    return { status: 'removed', guard }
  } finally {
    rmSync(guard, { force: true })
  }
}

/**
 * Whether a guard was left behind: its process has stopped, or it is still empty some seconds
 * after it was made (a guard is empty only between its creation and writing its pid).
 */
function guardAbandoned(guard) {
  const pid = readLock(guard)
  if (pid === null) return false
  if (pid !== '') return !processAlive(pid)
  try {
    return Date.now() - lstatSync(guard).mtimeMs > 5000
  } catch {
    return false
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
    if (!slotLockName.test(file)) continue
    const { status, guard } = removeStaleLock(resolve(dir, file), checkoutGone, options)
    if (status === 'stuck') {
      console.warn(
        `The checkout holding ${resolve(dir, file)} is gone, but a run that stopped left ${guard}, ` +
          'which keeps it from being released. Delete that file to release the slot.',
      )
    }
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
    writePrivateFile(instanceFile, JSON.stringify({ slot }, null, 2) + '\n')
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
 * What `pnpm dev` and the Convex CLI write in this checkout, relative to it. The dev scripts
 * write secrets, the slot, the run lock and bridge logins under .data; the CLI writes the
 * backend's database and settings under packages/backend/.convex, its address to .env.local,
 * generated code to the _generated directories, and .gitignore entries.
 *
 * Each place in DATA_PATHS must really be in the checkout, and nothing in a DATA_TREES
 * directory may be a symlink: a write through one would change a file somewhere else.
 */
const DATA_PATHS = [
  '.data',
  'packages/backend',
  'packages/backend/.gitignore',
  'packages/backend/.env.local',
  'packages/backend/.convex',
  'packages/backend/convex',
  'packages/backend/convex/betterAuth',
]
const DATA_TREES = [
  '.data',
  'packages/backend/.convex',
  'packages/backend/convex/_generated',
  'packages/backend/convex/betterAuth/_generated',
]

/**
 * Refuses unless what `pnpm dev` and the Convex CLI write in this checkout (`top`) is really in
 * it: DATA_PATHS not symlinks and not reached through one that leads outside, and no symlink
 * anywhere in DATA_TREES (walked without following links). Checked before anything is written,
 * and again before Convex commands. Our own writes also refuse links on their own
 * (`privateDir`, `writePrivateFile`, O_EXCL locks); the CLI's can't, so this is what keeps them in.
 */
export function assertCheckoutPaths(top = root) {
  const inside = realpathSync(top)
  const problems = []
  const lstat = (path) => {
    try {
      return lstatSync(path)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  const linkTarget = (path) => {
    try {
      return ` to ${readlinkSync(path)}`
    } catch {
      return ''
    }
  }
  for (const name of DATA_PATHS) {
    const path = resolve(top, name)
    const stat = lstat(path)
    if (!stat) continue
    let real = null
    try {
      real = realpathSync(path)
    } catch {}
    if (stat.isSymbolicLink()) problems.push(`${name} is a symlink${linkTarget(path)}`)
    else if (real !== inside && !real?.startsWith(inside + sep)) problems.push(`${name} leads outside it, to ${real}`)
  }
  for (const tree of DATA_TREES) {
    const pending = [tree]
    while (pending.length > 0 && problems.length < 20) {
      const name = pending.pop()
      const stat = lstat(resolve(top, name))
      if (!stat) continue
      if (stat.isSymbolicLink()) {
        if (!problems.some((problem) => problem.startsWith(`${name} `))) {
          problems.push(`${name} is a symlink${linkTarget(resolve(top, name))}`)
        }
      } else if (stat.isDirectory()) {
        for (const entry of readdirSync(resolve(top, name))) pending.push(join(name, entry))
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `pnpm dev keeps this checkout's data inside the checkout, and won't write anywhere else:\n  - ${problems.join('\n  - ')}\n` +
        'Replace those with real files and directories in the checkout.',
    )
  }
}

/**
 * Whether a backend is using this checkout's backend data (`dir`/.convex/local), on any port.
 * Says which, or null; before a reset deletes the data from under it. It is in use when:
 *
 * - something listens on the ports the backend last ran on (.convex/local/default/config.json);
 * - on Linux, a process (from `proc`) has a file there open, runs in a directory there, or names
 *   a path there in its arguments, relative ones read from its working directory; or it is a
 *   Convex local backend running anywhere in the checkout. One that can't be inspected
 *   (another user's) counts unless it runs in a container, or its PID is in `ignoring`
 *   (`procUsing` says why);
 * - elsewhere, a process names the data's absolute path in its arguments (`ps`).
 *
 * Only a process's ID and program name are ever shown: the local backend's arguments include
 * its instance secret.
 */
export async function backendInUse(dir = backendDir, { proc = '/proc', ignoring = [] } = {}) {
  const local = resolve(dir, '.convex/local')
  let config = null
  try {
    config = JSON.parse(readFileSync(resolve(local, 'default/config.json'), 'utf8'))
  } catch {}
  for (const port of [config?.ports?.cloud, config?.ports?.site]) {
    if (Number.isInteger(port) && !(await isFree(port))) {
      return `something is listening on port ${port}, where this checkout's backend last ran`
    }
  }
  // Each place as given and as resolved: /proc gives open files and working directories
  // resolved, and arguments as the process was given them.
  const spellings = (paths) => {
    const all = new Set(paths)
    for (const path of paths) {
      try {
        all.add(realpathSync(path))
      } catch {}
    }
    return [...all]
  }
  const within = (tops) => (path) =>
    Boolean(path) &&
    isAbsolute(path) &&
    tops.some((top) => resolve(path) === top || resolve(path).startsWith(top + sep))
  const ours = within(spellings([local]))
  // In this checkout, and not in another one inside it (the main checkout holds the worktrees
  // in .worktrees): no directory between it and the checkout's top has a .git of its own.
  const checkoutTops = spellings(dir === backendDir ? [root] : [dir])
  const inCheckout = (path) => {
    if (!within(checkoutTops)(path)) return false
    for (let at = resolve(path); !checkoutTops.includes(at); at = dirname(at)) {
      if (existsSync(join(at, '.git'))) return false
      if (dirname(at) === at) return false
    }
    return true
  }
  if (proc !== '/proc' || existsSync('/proc/self')) return procUsing(proc, { ours, inCheckout, ignoring })
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listed.status !== 0) {
    console.warn("Couldn't list processes, so only the backend's ports were checked.")
    return null
  }
  for (const line of listed.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)(.*)$/)
    if (!match || Number(match[1]) === process.pid) continue
    const args = match[2] + match[3]
    if (spellings([local]).some((path) => args.includes(path + sep) || args.endsWith(path))) {
      return `process ${match[1]} (${basename(match[2])}) is using its data`
    }
  }
  return null
}

/** Container runtimes' cgroup paths: `/system.slice/docker-<id>.scope`, `/docker/<id>`, and so on. */
const CONTAINER_CGROUP = /(?:^|[/.-])(?:docker|containerd|cri-containerd|crio|podman|libpod|kubepods|lxc)(?:[/.-]|$)/

/**
 * Whether process `base` (a /proc entry) runs in a container: its cgroup is a container
 * runtime's. Its cgroup file is readable by everyone, even when its files and directory aren't.
 * A cgroup namespace other than ours isn't taken as one: that says nothing about which files
 * it shares with this machine.
 */
function inContainer(base) {
  try {
    const lines = readFileSync(join(base, 'cgroup'), 'utf8').split('\n')
    return lines.some((line) => CONTAINER_CGROUP.test(line.split(':').slice(2).join(':')))
  } catch {
    return false
  }
}

/**
 * The Linux half of `backendInUse`: every process in `proc`, by its open files, directory and
 * arguments.
 *
 * A Convex local backend whose files and directory can't be read is another user's, and what it
 * opens can't be told from its arguments: it opens a database and storage in its directory when
 * none is given, and SQLite paths and URIs are read in ways a check here can't reproduce. So it
 * counts as using this checkout's data, unless it runs in a container (its paths are the
 * container's own; the self-hosted bundle keeps its data in named volumes, not a checkout) or
 * its PID is in `ignoring`, which someone sure it is unrelated passes with `--reset-ignoring`.
 */
function procUsing(proc, { ours, inCheckout, ignoring }) {
  const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH'
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    const base = join(proc, entry)
    let name
    try {
      name = readFileSync(join(base, 'comm'), 'utf8').trim()
    } catch {
      continue // It has exited.
    }
    let unreadable = false
    let exited = false
    const attempt = (read, fallback) => {
      try {
        return read()
      } catch (error) {
        if (gone(error)) exited = true
        else unreadable = true
        return fallback
      }
    }
    const cwd = attempt(() => readlinkSync(join(base, 'cwd')), null)
    const args = attempt(() => readFileSync(join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean), [])
    const fds = attempt(() => readdirSync(join(base, 'fd')), []).flatMap((fd) => {
      try {
        return [readlinkSync(join(base, 'fd', fd))]
      } catch {
        return []
      }
    })
    if (exited) continue
    // Its program, not its arguments: the first argument is the program's path.
    const program = args[0] ? basename(args[0]) : name
    const backend = name.startsWith('convex-local-ba')
    // An argument can be a path, or end in one (`--local-storage=<path>`); relative ones are
    // relative to the process's working directory.
    const named = args
      .flatMap((arg) => [arg, arg.slice(arg.indexOf('=') + 1)])
      .map((arg) => (isAbsolute(arg) || !cwd ? arg : resolve(cwd, arg)))
    if ([cwd, ...fds.map((fd) => fd.replace(/ \(deleted\)$/, '')), ...named].some(ours)) {
      return `process ${entry} (${program}) is using its data`
    }
    // A local backend opens its data relative to its directory by default.
    if (backend && inCheckout(cwd))
      return `process ${entry} (${program}) is a Convex local backend running in this checkout`
    if (backend && unreadable && !inContainer(base) && !ignoring.includes(Number(entry))) {
      return (
        `process ${entry} (${program}) is a Convex local backend, not in a container, whose open files can't be ` +
        'read here, so it may be using this checkout’s data. Stop it, or if it is certainly unrelated, run again ' +
        `with --reset-ignoring ${entry}`
      )
    }
  }
  return null
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
    LOGIN_BROWSER_TOKEN: secret,
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
  writePrivateFile(
    resolve(dataDir, 'dev.env'),
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
  )
}

export const convex = (...args) => ['exec', 'convex', ...args]

/** Whether this branch's backend has migrations (packages/backend/convex/migrations.ts). */
export function hasMigrations() {
  return existsSync(resolve(backendDir, 'convex/migrations.ts'))
}

/**
 * Runs the backend's migrations on this checkout's local backend: its one entry point,
 * `migrations:runAll`, which runs every migration in order, each safe to run any number of
 * times. It's called directly over HTTP with the admin key from the checkout's own
 * `.convex/local/default/config.json`, not through the Convex CLI, which would read the
 * dotenv files again and could be pointed somewhere else by then.
 */
export async function runMigrations(url) {
  const config = JSON.parse(readFileSync(resolve(backendDir, '.convex/local/default/config.json'), 'utf8'))
  const backendRequire = createRequire(resolve(backendDir, 'package.json'))
  const { ConvexHttpClient } = backendRequire('convex/browser')
  const { makeFunctionReference } = backendRequire('convex/server')
  const client = new ConvexHttpClient(url)
  client.setAdminAuth(config.adminKey)
  await client.action(makeFunctionReference('migrations:runAll'), {})
  console.log('Ran migrations:runAll.')
}

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
 * machine.
 *
 * Until .convex/local holds a deployment, the CLI also looks for the one it is about to use in
 * your home directory (~/.convex/anonymous-convex-backend-state, where older versions kept
 * them, shared by every project), and would push to it and change its data. So then
 * .env.local may name no deployment at all, and there must be none there under the name the
 * CLI gives a new one in agent mode (anonymous-agent).
 *
 * Checked before every Convex command, and after creating the backend with `requireConfigured`.
 */
export function assertLocalBackend({ requireConfigured = true, dir = backendDir, home = homedir() } = {}) {
  const problems = []
  let local = null
  try {
    local = JSON.parse(readFileSync(resolve(dir, '.convex/local/default/config.json'), 'utf8'))
  } catch {}
  const ours = local?.deploymentName ? `anonymous:${local.deploymentName}` : null
  const allowed = {
    CONVEX_DEPLOYMENT: (value) => {
      if (ours === null && value.startsWith('anonymous:')) {
        return (
          `names the deployment "${value}", which this checkout's .convex/local doesn't hold: ` +
          'the Convex CLI would look for it in your home directory. Delete packages/backend/.env.local'
        )
      }
      return value === ours ? null : `names the deployment "${value}", not this checkout's local backend`
    },
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
  if (requireConfigured && ours === null) {
    problems.push('this checkout has no local backend in packages/backend/.convex/local')
  }
  const legacy = resolve(home, '.convex/anonymous-convex-backend-state/anonymous-agent')
  if (ours === null && existsSync(legacy)) {
    problems.push(
      `${legacy} holds a backend from outside this checkout, which the Convex CLI would use instead of ` +
        "creating this checkout's own. Move it aside",
    )
  }
  if (problems.length > 0) {
    throw new Error(
      `pnpm dev only works with this checkout's own local backend, and won't touch any other:\n  - ${problems.join('\n  - ')}\n` +
        'Move those files aside, or start over (apps/docs/src/content/docs/contributing/local-development.mdx).',
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

/**
 * Unsets variables on a backend; one that isn't set is left as it is. `options` says which
 * backend, as for `setConvexEnv`.
 */
export function removeConvexEnv(names, options) {
  for (const name of names) {
    capture(
      'pnpm',
      convex('env', 'remove', name, ...(options.deployment ? ['--deployment', options.deployment] : [])),
      { ...options, quiet: true },
    )
  }
}

/** The Go toolchain: on PATH, or where the dev VM keeps it. */
export function goEnv() {
  const local = resolve(homedir(), '.local/go/bin')
  const onPath = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0
  if (onPath) return {}
  if (existsSync(resolve(local, 'go'))) return { PATH: `${local}${delimiter}${process.env.PATH}` }
  throw new Error('Go 1.27 is needed for the bridge host: https://go.dev/dl/ (or put it in ~/.local/go)')
}

/**
 * Builds the bridge host binary. Go's build cache makes this quick when nothing changed.
 * With `signal`, Signal's connector is built in, linking libsignal from `libsignalDir`.
 */
export function buildBridgeHost({ signal = false } = {}) {
  const goEnvironment = goEnv()
  // The sign-in browser's launcher, from the same module.
  run('go', ['build', '-o', 'bin/login-browser', './cmd/login-browser'], { cwd: bridgeDir, env: goEnvironment })
  if (!signal) {
    run('go', ['build', '-o', 'bin/bridge-host', './cmd/bridge-host'], { cwd: bridgeDir, env: goEnvironment })
    return resolve(bridgeDir, 'bin/bridge-host')
  }
  const dir = libsignalDir()
  const libraryPath = [dir, process.env.LIBRARY_PATH].filter(Boolean).join(delimiter)
  run('go', ['build', '-tags', 'libsignal', '-o', 'bin/bridge-host', './cmd/bridge-host'], {
    cwd: bridgeDir,
    env: { ...goEnvironment, LIBRARY_PATH: libraryPath },
  })
  return resolve(bridgeDir, 'bin/bridge-host')
}

/**
 * The directory holding libsignal_ffi.a for a bridge host built with Signal: LIBSIGNAL_FFI_DIR,
 * or .data/libsignal in this checkout. It must be the libsignal version mautrix-signal's
 * bindings were generated against, which only the link would otherwise check; this says what
 * is missing instead. Building it: docs/networks/signal.md. `module` is mautrix-signal's source:
 * the bridge host builds against the patched copy in this checkout (third_party/README.md).
 */
export function libsignalDir(module = resolve(bridgeDir, 'third_party/mautrix-signal')) {
  const dir = process.env.LIBSIGNAL_FFI_DIR ? resolve(process.env.LIBSIGNAL_FFI_DIR) : resolve(dataDir, 'libsignal')
  const pinned = readFileSync(resolve(module, 'pkg/libsignalgo/signalversion/version.go'), 'utf8')
  const version = /const Version = "v(\d+\.\d+\.\d+)"/.exec(pinned)?.[1]
  if (!version) throw new Error(`Couldn't tell which libsignal version mautrix-signal needs (${module}).`)
  const how = `Build libsignal v${version} (apps/docs/src/content/docs/networks/signal.md) and put its libsignal_ffi.a there, or set LIBSIGNAL_FFI_DIR to the directory that has it.`
  const library = resolve(dir, 'libsignal_ffi.a')
  if (!existsSync(library))
    throw new Error(`Signal's bridge host links libsignal, and ${library} doesn't exist. ${how}`)
  // libsignalgo calls signal_ffi_version_<version> to fail the link on any other version.
  if (!readFileSync(library).includes(`signal_ffi_version_${version.replaceAll('.', '_')}`)) {
    throw new Error(`${library} isn't libsignal v${version}, the version mautrix-signal needs. ${how}`)
  }
  return dir
}

/**
 * The Chromium the sign-in browser runs: CHROMIUM_PATH, or the first Chromium or Chrome on
 * PATH. Without one, `pnpm dev` runs no sign-in browser and cookie logins are pasted by hand.
 */
export function findChromium() {
  const names = process.env.CHROMIUM_PATH
    ? [process.env.CHROMIUM_PATH]
    : ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']
  for (const name of names) {
    const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  return null
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
      // A backend that accepts the request and never answers mustn't hold setup up for good.
      signal: AbortSignal.timeout(30_000),
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
      `This backend already has an admin who isn't the test account. Sign in as that admin, or start this checkout's backend over with "pnpm dev --setup --reset" (apps/docs/src/content/docs/contributing/local-development.mdx).`,
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
    const { status, guard } = removeStaleLock(path, (pid) => !processAlive(pid))
    if (status === 'removed') continue
    if (status === 'stuck') {
      throw new Error(
        `${path} was left by a run that stopped, but so was ${guard}, which keeps it from being taken over. ` +
          'Delete that file and try again.',
      )
    }
    if (status === 'busy') throw new Error(`Another run is taking over ${path} right now. Try again.`)
    const pid = readLock(path)
    if (pid !== null) {
      throw new Error(
        busy?.(pid || 'starting') ?? `Another run (process ${pid || 'starting'}) holds ${name}. Wait for it to finish.`,
      )
    }
  }
  throw new Error(`Could not take the lock ${path}.`)
}

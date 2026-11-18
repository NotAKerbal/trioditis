// What keeps `pnpm dev` on this checkout's own local backend and out of other checkouts' way:
// the Convex CLI's deployment variables are stripped from its environment, a checkout whose
// packages/backend points at any other backend is refused before anything is pushed or set,
// slots and run locks are released only when their holder is really gone, and a reset deletes
// nothing outside the checkout.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCheckoutPaths,
  assertLocalBackend,
  backendInUse,
  holdLock,
  parseDotenv,
  privateDir,
  releaseStaleSlots,
  removeFromCheckout,
  removeStaleLock,
  slotHolder,
  takeSlot,
  waitFor,
  writePrivateFile,
} from '../lib.mjs'

const backend = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'trioditis-backend-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}
const configured = { '.convex/local/default/config.json': '{"deploymentName":"anonymous-agent"}' }
const ours = 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n'

void test('accepts this checkout’s anonymous local backend', () => {
  assertLocalBackend({ dir: backend({ ...configured, '.env.local': 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n' }) })
})

void test('accepts a checkout with no backend yet, only while creating it', () => {
  const dir = backend({})
  const home = backend({})
  assertLocalBackend({ dir, home, requireConfigured: false })
  assert.throws(() => assertLocalBackend({ dir, home }), /\.env\.local is missing/)
})

// Without a backend in .convex/local, the Convex CLI finds a deployment of the same name in
// ~/.convex (older versions kept them there) and pushes to it.
void test('refuses, before creating the backend, anything the CLI would find in your home directory', () => {
  const home = backend({ '.convex/anonymous-convex-backend-state/anonymous-agent/config.json': '{}' })
  const empty = backend({})
  assert.throws(
    () => assertLocalBackend({ dir: empty, home, requireConfigured: false }),
    /anonymous-convex-backend-state\/anonymous-agent holds a backend from outside this checkout/,
  )
  // Once .convex/local holds this checkout's backend, the CLI uses only that.
  assertLocalBackend({ dir: backend({ ...configured, '.env.local': ours }), home })
  // A selector for a deployment .convex/local doesn't hold sends the CLI looking in ~/.convex.
  const cleanHome = backend({})
  for (const files of [{ '.env.local': ours }, { '.convex/local/default/config.json': '{}', '.env.local': ours }]) {
    const dir = backend(files)
    assert.throws(
      () => assertLocalBackend({ dir, home: cleanHome, requireConfigured: false }),
      /which this checkout's \.convex\/local doesn't hold/,
    )
  }
})

void test('refuses a cloud or self-hosted deployment in .env.local', () => {
  for (const deployment of ['dev:happy-cat-123', 'prod:spotted-chihuahua-840', 'local:someone-else']) {
    const dir = backend({ ...configured, '.env.local': `CONVEX_DEPLOYMENT=${deployment}\n` })
    assert.throws(() => assertLocalBackend({ dir }), /not this checkout's local backend/)
  }
  const selfHosted = backend({ ...configured, '.env.local': 'CONVEX_SELF_HOSTED_URL=https://convex.example.com\n' })
  assert.throws(() => assertLocalBackend({ dir: selfHosted }), /no deployment/)
})

void test('accepts what the CLI itself writes to .env.local for a local deployment', () => {
  const written =
    '# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=anonymous:anonymous-agent\n\n' +
    'CONVEX_URL=http://127.0.0.1:4212\n\nCONVEX_SITE_URL=http://127.0.0.1:4213\n'
  assertLocalBackend({ dir: backend({ ...configured, '.env.local': written }) })
})

void test('refuses an anonymous deployment that isn’t this checkout’s', () => {
  const dir = backend({ ...configured, '.env.local': 'CONVEX_DEPLOYMENT=anonymous:anonymous-other\n' })
  assert.throws(() => assertLocalBackend({ dir }), /not this checkout's local backend/)
})

// The review's two fixtures: the Convex CLI's bundled dotenv reads the key in both, and a key
// takes precedence over CONVEX_DEPLOYMENT.
void test('refuses a deploy key beside the anonymous selector in .env.local', () => {
  const dir = backend({ ...configured, '.env.local': `${ours}CONVEX_DEPLOY_KEY=prod:x|y\n` })
  assert.throws(() => assertLocalBackend({ dir }), /\.env\.local sets CONVEX_DEPLOY_KEY/)
})

void test('refuses an export-prefixed deploy key in .env', () => {
  const dir = backend({ ...configured, '.env.local': ours, '.env': 'export CONVEX_DEPLOY_KEY=prod:x|y\n' })
  assert.throws(() => assertLocalBackend({ dir }), /\.env sets CONVEX_DEPLOY_KEY/)
})

void test('refuses every way dotenv can spell a selector', () => {
  const spellings = [
    'CONVEX_DEPLOY_KEY=prod:x|y',
    '  export   CONVEX_DEPLOY_KEY = "prod:x|y"  # a comment',
    "CONVEX_DEPLOYMENT_TOKEN='x'",
    'CONVEX_SELF_HOSTED_URL: https://convex.example.com',
    'CONVEX_SELF_HOSTED_ADMIN_KEY=`admin`',
    'CONVEX_ACCOUNT=someone',
    'CONVEX_DEPLOYMENT=dev:happy-cat-123',
    'CONVEX_URL=https://happy-cat-123.convex.cloud',
    'CONVEX_SOMETHING_NEW=x',
  ]
  for (const line of spellings) {
    for (const [file, text] of [
      ['.env.local', `${ours}${line}\r\n`],
      ['.env', `# settings\n${line}\n`],
    ]) {
      const dir = backend({ ...configured, '.env.local': ours, [file]: text })
      assert.throws(() => assertLocalBackend({ dir }), /pnpm dev only works/, `${file}: ${line}`)
    }
  }
  // A later line wins in dotenv, so a cloud deployment after ours is what the CLI would use.
  const later = backend({ ...configured, '.env.local': `${ours}CONVEX_DEPLOYMENT=prod:spotted-chihuahua-840\n` })
  assert.throws(() => assertLocalBackend({ dir: later }), /prod:spotted-chihuahua-840/)
  // A selector inside a quoted value isn't one dotenv reads, but is refused all the same.
  const quoted = backend({ ...configured, '.env.local': ours, '.env': 'NOTE="a\nCONVEX_DEPLOY_KEY=prod:x|y\n"\n' })
  assert.throws(() => assertLocalBackend({ dir: quoted }), /CONVEX_DEPLOY_KEY/)
})

void test('refuses a dotenv vault, which DOTENV_KEY would load instead', () => {
  const dir = backend({ ...configured, '.env.local': ours, '.env.vault': 'DOTENV_VAULT_DEVELOPMENT=x\n' })
  assert.throws(() => assertLocalBackend({ dir }), /\.env\.vault exists/)
})

void test('parses dotenv files exactly as the Convex CLI’s bundled dotenv does', () => {
  const bundle = readFileSync(new URL('../../node_modules/convex/dist/cli.bundle.cjs', import.meta.url), 'utf8')
  const ours = readFileSync(new URL('../lib.mjs', import.meta.url), 'utf8')
  const pattern = bundle.match(/var LINE = (\/.*\/)mg;/)?.[1]
  assert.ok(pattern, 'the Convex CLI bundle has no dotenv LINE pattern: check how it parses dotenv now')
  assert.ok(ours.includes(`${pattern}gm`), 'parseDotenv’s pattern differs from the bundled dotenv’s')
  assert.deepEqual(parseDotenv('export A = "x\\ny" # c\nB: v\r\nC=\'s p\'\nD=a#b\n#E=1\n'), {
    A: 'x\ny',
    B: 'v',
    C: 's p',
    D: 'a',
  })
})

void test('strips every deployment-selecting variable from the local backend’s commands', () => {
  const selectors = {
    CONVEX_DEPLOY_KEY: 'prod:x|secret',
    CONVEX_DEPLOYMENT: 'dev:happy-cat-123',
    CONVEX_URL: 'https://happy-cat-123.convex.cloud',
    CONVEX_SELF_HOSTED_URL: 'https://convex.example.com',
    CONVEX_SELF_HOSTED_ADMIN_KEY: 'admin',
    CONVEX_SOMETHING_NEW: 'x',
    DOTENV_KEY: 'dotenv://:key@dotenvx.com/vault/.env.vault?environment=development',
  }
  const script = `
    import { env, localConvex } from './scripts/lib.mjs'
    const child = env(localConvex.env, localConvex.unset)
    console.log(JSON.stringify(Object.keys(child).filter((name) => /^(CONVEX_|DOTENV_)/.test(name))))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, ...selectors },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['CONVEX_AGENT_MODE'])
})

const temp = () => mkdtempSync(join(tmpdir(), 'trioditis-locks-'))
const checkout = (dir, name) => {
  mkdirSync(join(dir, name, '.git'), { recursive: true })
  return join(dir, name)
}

void test('a stale slot is released once, never the lock that replaced it', () => {
  const dir = temp()
  const slots = join(dir, 'slots')
  const a = checkout(dir, 'a')
  const b = checkout(dir, 'b')
  takeSlot(1, join(dir, 'deleted-worktree'), slots)
  // A and B both see slot 1's holder is gone. B releases it and takes the slot before A goes on.
  releaseStaleSlots(slots, {
    beforeGuard: () => {
      releaseStaleSlots(slots)
      assert.equal(slotHolder(1, slots), null)
      assert.ok(takeSlot(1, b, slots))
    },
  })
  assert.equal(slotHolder(1, slots), b)
  assert.equal(takeSlot(1, a, slots), false)
})

void test('a slot being released by another process is left to it', () => {
  const dir = temp()
  const slots = join(dir, 'slots')
  takeSlot(1, join(dir, 'deleted-worktree'), slots)
  // B gets the guard between A's two reads: A leaves the slot to B, which releases it once.
  let released = null
  releaseStaleSlots(slots, {
    beforeGuard: () => {
      released = removeStaleLock(join(slots, '1.lock'), () => true)
    },
  })
  assert.equal(released.status, 'removed')
  assert.equal(slotHolder(1, slots), null)
  assert.equal(existsSync(join(slots, 'releasing', '1.lock')), false)
})

void test('a lock is left alone while another process holds its guard', () => {
  const dir = temp()
  const slots = join(dir, 'slots')
  takeSlot(1, join(dir, 'deleted-worktree'), slots)
  mkdirSync(join(slots, 'releasing'))
  writeFileSync(join(slots, 'releasing', '1.lock'), `${process.pid}\n`)
  releaseStaleSlots(slots)
  assert.equal(slotHolder(1, slots), join(dir, 'deleted-worktree'))
})

void test('a slot whose checkout exists, or whose lock is still being written, is kept', () => {
  const dir = temp()
  const slots = join(dir, 'slots')
  takeSlot(1, checkout(dir, 'a'), slots)
  writeFileSync(join(slots, '2.lock'), '')
  releaseStaleSlots(slots)
  assert.equal(slotHolder(1, slots), join(dir, 'a'))
  assert.equal(slotHolder(2, slots), '')
})

void test('a run lock refuses a live holder and takes over a dead one', () => {
  const dir = temp()
  writeFileSync(join(dir, 'live.lock'), `${process.ppid}\n`)
  assert.throws(() => holdLock('live', { dir, busy: (pid) => `busy ${pid}` }), new RegExp(`busy ${process.ppid}`))
  // A process that has exited: its pid is free (or, rarely, reused, which only refuses).
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(dir, 'dead.lock'), `${dead}\n`)
  assert.equal(holdLock('dead', { dir }), join(dir, 'dead.lock'))
  assert.equal(readFileSync(join(dir, 'dead.lock'), 'utf8'), `${process.pid}\n`)
  assert.throws(() => holdLock('dead', { dir }), /Another run/)
})

void test('a checkout runs one pnpm dev at a time, and --reset needs --setup', () => {
  const dir = temp()
  const script = (args) =>
    spawnSync(process.execPath, ['scripts/dev.mjs', ...args], {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, XDG_STATE_HOME: dir },
      encoding: 'utf8',
    })
  const reset = script(['--reset'])
  assert.equal(reset.status, 1)
  assert.match(reset.stderr, /--reset` only goes with `--setup`/)
  // Holding this checkout's run lock, as a running `pnpm dev` does: a reset is refused.
  const lock = new URL('../../.data/dev.lock', import.meta.url)
  mkdirSync(new URL('../../.data', import.meta.url), { recursive: true })
  if (existsSync(lock)) return // This checkout's own `pnpm dev` is running: that's the lock.
  writeFileSync(lock, `${process.pid}\n`)
  try {
    const busy = script(['--setup', '--reset'])
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, new RegExp(`Another \`pnpm dev\` for this checkout \\(process ${process.pid}\\)`))
  } finally {
    rmSync(lock, { force: true })
  }
})

void test('a reset deletes nothing a link leads to outside the checkout', () => {
  const dir = temp()
  const top = join(dir, 'checkout')
  const outside = join(dir, 'outside')
  mkdirSync(join(outside, 'local'), { recursive: true })
  writeFileSync(join(outside, 'local', 'keep'), 'x')
  writeFileSync(join(outside, '.env.local'), 'x')
  mkdirSync(join(top, 'packages/backend'), { recursive: true })
  mkdirSync(join(top, '.data'))
  // .convex is a link out of the checkout: deleting .convex/local through it is refused.
  symlinkSync(outside, join(top, 'packages/backend/.convex'))
  assert.throws(() => removeFromCheckout(join(top, 'packages/backend/.convex/local'), top), /outside this checkout/)
  assert.ok(existsSync(join(outside, 'local', 'keep')))
  // A link at the path itself is removed, not what it leads to.
  symlinkSync(join(outside, '.env.local'), join(top, 'packages/backend/.env.local'))
  symlinkSync(join(outside, 'local'), join(top, '.data/bridge-fake'))
  removeFromCheckout(join(top, 'packages/backend/.env.local'), top)
  removeFromCheckout(join(top, '.data/bridge-fake'), top)
  assert.equal(existsSync(join(top, 'packages/backend/.env.local')), false)
  assert.equal(existsSync(join(top, '.data/bridge-fake')), false)
  assert.ok(existsSync(join(outside, '.env.local')))
  assert.ok(existsSync(join(outside, 'local', 'keep')))
  // What really is inside is deleted, and what isn't there is fine.
  mkdirSync(join(top, '.data/bridge-whatsapp/db'), { recursive: true })
  removeFromCheckout(join(top, '.data/bridge-whatsapp'), top)
  assert.equal(existsSync(join(top, '.data/bridge-whatsapp')), false)
  removeFromCheckout(join(top, 'missing/thing'), top)
})

void test('waiting gives up on time even when a request never gets an answer', async () => {
  // Accepts every request and never answers it.
  const server = createServer(() => {})
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const started = Date.now()
  try {
    await assert.rejects(waitFor(`http://127.0.0.1:${server.address().port}/`, 2), /did not respond within 2 seconds/)
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

void test('a guard left by a stopped run says which file to delete', () => {
  const dir = temp()
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(dir, 'dev.lock'), `${dead}\n`)
  mkdirSync(join(dir, 'releasing'))
  const guard = join(dir, 'releasing', 'dev.lock')
  // Left by a stopped process: stuck, and the run lock's message names the guard.
  writeFileSync(guard, `${dead}\n`)
  assert.equal(removeStaleLock(join(dir, 'dev.lock'), () => true).status, 'stuck')
  assert.throws(
    () => holdLock('dev', { dir }),
    (error) => error.message.includes(`Delete that file`) && error.message.includes(guard),
  )
  // Empty and fresh: another process is between creating it and writing its pid.
  writeFileSync(guard, '')
  assert.equal(removeStaleLock(join(dir, 'dev.lock'), () => true).status, 'busy')
  assert.throws(() => holdLock('dev', { dir }), /taking over .* right now/)
  // Empty for longer than that takes: left behind.
  utimesSync(guard, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.equal(removeStaleLock(join(dir, 'dev.lock'), () => true).status, 'stuck')
  // Nothing is removed automatically; once the guard is deleted, the lock is taken over.
  assert.equal(readFileSync(join(dir, 'dev.lock'), 'utf8'), `${dead}\n`)
  rmSync(guard)
  assert.equal(holdLock('dev', { dir }), join(dir, 'dev.lock'))
})

void test('refuses a checkout whose data would be written through a symlink', () => {
  const dir = temp()
  const top = join(dir, 'checkout')
  const outside = join(dir, 'outside')
  mkdirSync(join(top, 'packages/backend'), { recursive: true })
  mkdirSync(join(outside, 'local'), { recursive: true })
  assertCheckoutPaths(top)
  for (const [name, target] of [
    ['packages/backend/.convex', outside],
    ['packages/backend/.convex/local', join(outside, 'local')],
    ['.data', outside],
    ['packages/backend/.env.local', join(outside, 'env')],
  ]) {
    mkdirSync(join(top, name, '..'), { recursive: true })
    symlinkSync(target, join(top, name))
    assert.throws(() => assertCheckoutPaths(top), new RegExp(`${name.replaceAll('.', '\\.')} is a symlink`), name)
    rmSync(join(top, name))
  }
  // A link inside the checkout is refused too: the CLI would still write where it leads.
  mkdirSync(join(top, 'elsewhere'))
  symlinkSync(join(top, 'elsewhere'), join(top, '.data'))
  assert.throws(() => assertCheckoutPaths(top), /\.data is a symlink/)
})

/**
 * Runs this dev.mjs in a throwaway checkout (a git repository with only the scripts), with its
 * own state directory and home, so what it would do to a checkout's data can be seen.
 */
function throwawayCheckout() {
  const dir = temp()
  const top = join(dir, 'checkout')
  mkdirSync(join(top, 'scripts'), { recursive: true })
  mkdirSync(join(top, 'packages/backend'), { recursive: true })
  for (const file of ['dev.mjs', 'lib.mjs']) {
    writeFileSync(join(top, 'scripts', file), readFileSync(new URL(`../${file}`, import.meta.url)))
  }
  spawnSync('git', ['init', '-q', top])
  const home = join(dir, 'home')
  mkdirSync(home)
  const run = (args) =>
    spawnSync(process.execPath, [join(top, 'scripts/dev.mjs'), ...args], {
      cwd: top,
      env: { ...process.env, HOME: home, XDG_STATE_HOME: join(dir, 'state') },
      encoding: 'utf8',
    })
  return { dir, top, home, run }
}

void test('setup, start and reset refuse a symlinked .convex before writing anything', () => {
  const { dir, top, run } = throwawayCheckout()
  const outside = join(dir, 'outside')
  mkdirSync(join(outside, 'local/default'), { recursive: true })
  writeFileSync(join(outside, 'local/default/config.json'), '{"deploymentName":"anonymous-agent"}')
  symlinkSync(outside, join(top, 'packages/backend/.convex'))
  for (const args of [['--setup'], [], ['--setup', '--reset']]) {
    const result = run(args)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stderr, /packages\/backend\/\.convex is a symlink/)
  }
  assert.equal(existsSync(join(top, '.data')), false, 'nothing was written to the checkout')
  assert.deepEqual(
    readFileSync(join(outside, 'local/default/config.json'), 'utf8'),
    '{"deploymentName":"anonymous-agent"}',
  )
  assert.ok(existsSync(join(outside, 'local/default')), 'the reset deleted nothing')
})

void test('setup refuses a deployment in your home directory before any Convex command', () => {
  const { top, home, run } = throwawayCheckout()
  const legacy = join(home, '.convex/anonymous-convex-backend-state/anonymous-agent')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'config.json'), '{}')
  writeFileSync(join(top, 'packages/backend/.env.local'), 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n')
  const result = run(['--setup'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /which this checkout's \.convex\/local doesn't hold/)
  assert.match(result.stderr, /anonymous-agent holds a backend from outside this checkout/)
  // No Convex command ran: it would have made packages/backend/.convex or written to ~/.convex.
  assert.equal(existsSync(join(top, 'packages/backend/.convex')), false)
  assert.deepEqual(readdirSync(legacy), ['config.json'])
})

void test('a reset sees a backend using this checkout’s data, on any port', async () => {
  const dir = temp()
  const local = join(dir, '.convex/local/default')
  mkdirSync(local, { recursive: true })
  assert.equal(await backendInUse(dir), null)
  // Something listening where the backend last ran, which isn't this slot's port.
  const server = createServer(() => {})
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  writeFileSync(join(local, 'config.json'), JSON.stringify({ ports: { cloud: port, site: port + 1 } }))
  try {
    assert.match(await backendInUse(dir), new RegExp(`port ${port}`))
  } finally {
    server.close()
  }
  writeFileSync(join(local, 'config.json'), '{}')
  // A process given this checkout's database, as the Convex local backend is, on whatever ports.
  const backendLike = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(local, 'db.sqlite3')], {
    stdio: 'ignore',
  })
  try {
    for (let i = 0; i < 50 && (await backendInUse(dir)) === null; i++)
      await new Promise((done) => setTimeout(done, 100))
    const found = await backendInUse(dir)
    assert.match(found ?? '', new RegExp(`process ${backendLike.pid} \\(node\\) is using its data`))
    assert.ok(!found.includes('db.sqlite3'), 'its arguments are not shown')
  } finally {
    backendLike.kill()
  }
})

void test('refuses a symlink anywhere among the files it or the Convex CLI writes', () => {
  const dir = temp()
  const top = join(dir, 'checkout')
  const outside = join(dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'target'), 'keep')
  const dirs = ['.data/bridge-fake', 'packages/backend/.convex/local/default/convex_local_storage/modules']
  for (const name of [...dirs, 'packages/backend/convex/_generated', 'packages/backend/convex/betterAuth/_generated']) {
    mkdirSync(join(top, name), { recursive: true })
  }
  assertCheckoutPaths(top)
  for (const name of [
    '.data/dev.env',
    '.data/dev.json',
    '.data/dev.lock',
    '.data/secrets.json',
    '.data/releasing/dev.lock',
    '.data/bridge-fake/bridge.db',
    'packages/backend/.env.local',
    'packages/backend/.gitignore',
    'packages/backend/.convex/.gitignore',
    'packages/backend/.convex/local/default/config.json',
    'packages/backend/.convex/local/default/convex_local_backend.sqlite3',
    'packages/backend/.convex/local/default/convex_local_storage/modules/x.blob',
    'packages/backend/convex/_generated/api.js',
    'packages/backend/convex/betterAuth/_generated/api.ts',
  ]) {
    mkdirSync(join(top, name, '..'), { recursive: true })
    symlinkSync(join(outside, 'target'), join(top, name))
    assert.throws(() => assertCheckoutPaths(top), new RegExp(`${name.replaceAll('.', '\\.')} is a symlink`), name)
    rmSync(join(top, name))
  }
  assertCheckoutPaths(top)
  assert.equal(readFileSync(join(outside, 'target'), 'utf8'), 'keep')
})

void test('its own writes never follow a symlink, even one made after the checks', () => {
  const dir = temp()
  const outside = join(dir, 'outside')
  writeFileSync(outside, 'keep', { mode: 0o644 })
  // A file: the link is replaced by the file, and what it pointed to is untouched.
  symlinkSync(outside, join(dir, 'dev.env'))
  writePrivateFile(join(dir, 'dev.env'), 'SECRET=x\n')
  assert.equal(lstatSync(join(dir, 'dev.env')).isSymbolicLink(), false)
  assert.equal(readFileSync(join(dir, 'dev.env'), 'utf8'), 'SECRET=x\n')
  assert.equal(statSync(join(dir, 'dev.env')).mode & 0o777, 0o600)
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
  assert.equal(statSync(outside).mode & 0o777, 0o644)
  assert.deepEqual(readdirSync(dir).sort(), ['dev.env', 'outside'], 'no temporary file is left')
  // A directory: refused, and the target's mode is unchanged.
  const outsideDir = join(dir, 'outside-dir')
  mkdirSync(outsideDir, { mode: 0o755 })
  symlinkSync(outsideDir, join(dir, '.data'))
  assert.throws(() => privateDir(join(dir, '.data')), /is a symlink: not writing there/)
  assert.equal(statSync(outsideDir).mode & 0o777, 0o755)
  // A lock: O_EXCL won't create one through a link.
  const slots = join(dir, 'slots')
  mkdirSync(slots)
  symlinkSync(outside, join(slots, '1.lock'))
  assert.equal(takeSlot(1, dir, slots), false)
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
})

void test('setup refuses a symlinked .data/dev.env or config.json before writing anything', () => {
  for (const name of ['.data/dev.env', 'packages/backend/.convex/local/default/config.json']) {
    const { dir, top, run } = throwawayCheckout()
    const target = join(dir, 'target')
    writeFileSync(target, '{"deploymentName":"anonymous-agent"}', { mode: 0o644 })
    mkdirSync(join(top, name, '..'), { recursive: true })
    symlinkSync(target, join(top, name))
    const result = run(['--setup'])
    assert.equal(result.status, 1, name)
    assert.match(result.stderr, new RegExp(`${name.replaceAll('.', '\\.')} is a symlink`))
    assert.equal(readFileSync(target, 'utf8'), '{"deploymentName":"anonymous-agent"}')
    assert.equal(statSync(target).mode & 0o777, 0o644, 'not chmodded')
    assert.equal(existsSync(join(top, '.data/dev.json')), false, 'nothing was written')
  }
})

const linux = { skip: process.platform !== 'linux' && 'reads /proc' }

void test('a reset sees a backend started with relative paths, or holding its files open', linux, async () => {
  const dir = temp()
  const local = join(dir, '.convex/local/default')
  mkdirSync(local, { recursive: true })
  writeFileSync(join(local, 'db.sqlite3'), '')
  const idle = 'setInterval(() => {}, 1000)'
  const cases = [
    // Run in the backend's directory with a relative database path, as `cd` and a relative path would.
    { args: ['-e', idle, 'db.sqlite3'], cwd: local },
    // Run beside it, the path relative to that.
    { args: ['-e', idle, 'db=local/default/db.sqlite3'], cwd: join(dir, '.convex') },
    // Named nowhere, but with the database open (its path passed in the environment).
    {
      args: ['-e', `require('fs').openSync(process.env.DB, 'r'); ${idle}`],
      cwd: dir,
      env: { DB: join(local, 'db.sqlite3') },
    },
  ]
  for (const { args, cwd, env } of cases) {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' })
    try {
      let found = null
      for (let i = 0; i < 50 && found === null; i++) {
        await new Promise((done) => setTimeout(done, 100))
        found = await backendInUse(dir)
      }
      assert.match(found ?? '', new RegExp(`process ${child.pid} \\(node\\) is using its data`), args.join(' '))
      assert.ok(!found.includes('sqlite3'), 'its arguments are not shown')
    } finally {
      child.kill()
      if (child.exitCode === null && child.signalCode === null) await new Promise((done) => child.once('exit', done))
    }
  }
  assert.equal(await backendInUse(dir), null)
})

/** A stand-in for /proc in `dir`, with one process, 4242, whose files are laid out as given. */
function fakeProc(
  dir,
  { comm = 'convex-local-ba', args = ['convex-local-backend'], cgroup, cgroupNamespace, cwd = null, fds = null },
) {
  const proc = join(dir, 'proc')
  rmSync(proc, { recursive: true, force: true })
  mkdirSync(join(proc, '4242'), { recursive: true })
  writeFileSync(join(proc, '4242/comm'), `${comm}\n`)
  writeFileSync(join(proc, '4242/cmdline'), args.join('\0') + '\0')
  if (cgroup !== undefined) writeFileSync(join(proc, '4242/cgroup'), `${cgroup}\n`)
  if (cgroupNamespace !== undefined) {
    mkdirSync(join(proc, '4242/ns'))
    symlinkSync(cgroupNamespace, join(proc, '4242/ns/cgroup'))
  }
  // Another user's process: a cwd that isn't a link and an fd that isn't a directory make
  // reading them fail, as EACCES would. A readable one gets a real link and directory.
  if (cwd === null) writeFileSync(join(proc, '4242/cwd'), '')
  else symlinkSync(cwd, join(proc, '4242/cwd'))
  if (fds === null) writeFileSync(join(proc, '4242/fd'), '')
  else mkdirSync(join(proc, '4242/fd'))
  return proc
}

void test('a reset refuses a backend it can’t inspect, unless it runs in a container or is ignored', async () => {
  const dir = temp()
  mkdirSync(join(dir, '.convex/local/default'), { recursive: true })
  const host = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/some-terminal.scope'
  const refused =
    /process 4242 \(convex-local-backend\) is a Convex local backend, not in a container, .*--reset-ignoring 4242/
  // What it opens can't be told from its arguments, so every one of these is refused: the
  // review's cases (a relative database beside absolute storage; no database or storage given,
  // so the defaults in its directory; a dash-prefixed database after --; colons in names; SQLite
  // URIs; paths through links), and all-absolute paths elsewhere too.
  for (const args of [
    ['--local-storage', '/srv/elsewhere/storage', 'convex_local_backend.sqlite3'],
    ['--port', '4390'],
    ['--local-storage', '/srv/elsewhere/storage', '--', '-db.sqlite3'],
    ['--local-storage', '/srv/elsewhere/storage', 'a:b.sqlite3'],
    ['--local-storage', 'store:age', '/srv/elsewhere/db.sqlite3'],
    ['--local-storage', '/srv/elsewhere/storage', 'sqlite:/srv/elsewhere/db.sqlite3?mode=rwc'],
    ['--local-storage', '/srv/link/../storage', 'file:/srv/link/db.sqlite3?mode=rwc'],
    ['--local-storage', '/srv/elsewhere/storage', '/srv/elsewhere/db.sqlite3'],
    ['--db', 'postgres-v5', '--local-storage', '/srv/elsewhere/storage', 'postgres://convex@db:5432'],
  ]) {
    const proc = fakeProc(dir, { args: ['convex-local-backend', ...args], cgroup: host })
    assert.match((await backendInUse(dir, { proc })) ?? '', refused, args.join(' '))
  }
  // --reset-ignoring lets through exactly the PID it names.
  const proc = fakeProc(dir, { args: ['convex-local-backend', '--port', '4390'], cgroup: host })
  assert.equal(await backendInUse(dir, { proc, ignoring: [4242] }), null)
  assert.match((await backendInUse(dir, { proc, ignoring: [4243, 42] })) ?? '', refused)
  // In a container, as the self-hosted bundle's backend is: its paths are the container's own.
  for (const cgroup of [
    '0::/system.slice/docker-ed27313a7eedfefbde5ac7b73f65f19ada50b131c4ebdf9fd434fa326a497d81.scope',
    '0::/docker/ed27313a7eedfefbde5ac7b73f65f19ada50b131c4ebdf9fd434fa326a497d81',
    '0::/machine.slice/libpod-3f2a.scope/container',
    '0::/kubepods.slice/kubepods-besteffort.slice/cri-containerd-9c1d.scope',
    '12:memory:/lxc/web\n0::/lxc/web',
  ]) {
    const inContainer = fakeProc(dir, { args: ['convex-local-backend', 'convex_local_backend.sqlite3'], cgroup })
    assert.equal(await backendInUse(dir, { proc: inContainer }), null, cgroup)
  }
  // A cgroup namespace other than ours says nothing about which files it shares: refused.
  const otherNamespace = fakeProc(dir, {
    args: ['convex-local-backend', 'convex_local_backend.sqlite3'],
    cgroup: host,
    cgroupNamespace: 'cgroup:[4026530000]',
  })
  assert.match((await backendInUse(dir, { proc: otherNamespace })) ?? '', refused)
  // Not a local backend at all: another user's process is none of this check's business.
  assert.equal(await backendInUse(dir, { proc: fakeProc(dir, { comm: 'sshd', cgroup: host }) }), null)
})

void test('a reset refuses a backend it can inspect that runs anywhere in this checkout', async () => {
  const dir = temp()
  mkdirSync(join(dir, '.convex/local/default'), { recursive: true })
  mkdirSync(join(dir, 'src'))
  const host = '0::/user.slice/some-terminal.scope'
  // Its directory is in the checkout, though not in .convex/local: it opens data relative to it.
  const backend = fakeProc(dir, { cwd: join(dir, 'src'), fds: [], cgroup: host })
  assert.match(
    (await backendInUse(dir, { proc: backend })) ?? '',
    /process 4242 .* is a Convex local backend running in this checkout/,
  )
  // Another program there is fine, and so is a backend in another checkout inside this one.
  assert.equal(
    await backendInUse(dir, { proc: fakeProc(dir, { comm: 'bash', cwd: join(dir, 'src'), fds: [], cgroup: host }) }),
    null,
  )
  mkdirSync(join(dir, '.worktrees/other/.git'), { recursive: true })
  const nested = fakeProc(dir, { cwd: join(dir, '.worktrees/other'), fds: [], cgroup: host })
  assert.equal(await backendInUse(dir, { proc: nested }), null)
})

void test('--reset-ignoring takes a whole process ID, and only with --setup --reset', () => {
  const run = (args) =>
    spawnSync(process.execPath, ['scripts/dev.mjs', ...args], {
      cwd: new URL('../..', import.meta.url),
      env: { ...process.env, XDG_STATE_HOME: temp() },
      encoding: 'utf8',
    })
  assert.match(run(['--setup', '--reset-ignoring', '42']).stderr, /only goes with `--setup --reset`/)
  for (const option of [
    ['--reset-ignoring', 'x'],
    ['--reset-ignoring'],
    ['--reset-ignoring=42=typo'],
    ['--reset-ignoring=42abc'],
    ['--reset-ignoring=+42'],
    ['--reset-ignoring=042'],
    ['--reset-ignoring=4 2'],
    ['--reset-ignoring='],
    ['--reset-ignoring', '42', '--reset-ignoring=0'],
    ['--reset-ignoring=99999999999999999999'],
  ]) {
    assert.match(run(['--setup', '--reset', ...option]).stderr, /takes a process ID/, option.join(' '))
  }
  // A whole one gets past the check: in a throwaway checkout, which then stops for want of the
  // Convex CLI, before touching anything of this one.
  const { run: runThrowaway } = throwawayCheckout()
  for (const option of [['--reset-ignoring=42'], ['--reset-ignoring', '42', '--reset-ignoring', '7']]) {
    const result = runThrowaway(['--setup', '--reset', ...option])
    assert.doesNotMatch(result.stderr, /--reset-ignoring/, option.join(' '))
    assert.match(result.stdout, /Throwing this checkout’s backend data away/, option.join(' '))
  }
})

void test('lists the backend’s migrations from migrations.ts', async () => {
  const { migrationNames, parseMigrationNames } = await import('../lib.mjs')
  assert.deepEqual(migrationNames(), ['scheduleCommandDeadlines'])
  const source = [
    'export const one = internalMutation({',
    'export const typed: RegisteredMutation<"internal", {}, null> = internalMutation({',
    'export const generic = internalAction<{}>({',
    'export const nested = internalMutation<Record<string, Array<number>>>({',
    '/* export const commented = internalMutation({ */',
    '// export const lineCommented = internalMutation({',
    'export const notAMigration = query({',
    'const helper = internalMutation({',
  ].join('\n')
  assert.deepEqual(parseMigrationNames(source), ['one', 'typed', 'generic', 'nested'])
  const { parseMigrations } = await import('../lib.mjs')
  assert.deepEqual(
    parseMigrations(source).map((migration) => migration.kind),
    ['mutation', 'mutation', 'action', 'mutation'],
  )
})

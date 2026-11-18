// What keeps `pnpm dev` on this checkout's own local backend and out of other checkouts' way:
// the Convex CLI's deployment variables are stripped from its environment, a checkout whose
// packages/backend points at any other backend is refused before anything is pushed or set,
// slots and run locks are released only when their holder is really gone, and a reset deletes
// nothing outside the checkout.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  releaseStaleSlots,
  removeFromCheckout,
  removeStaleLock,
  slotHolder,
  takeSlot,
  waitFor,
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

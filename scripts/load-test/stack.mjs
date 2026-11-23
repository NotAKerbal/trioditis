// The backend a load test runs against: Postgres and the self-hosted Convex backend, the same
// pinned images as deploy/compose/compose.yml, each in its own container on a private network,
// with the functions of this checkout deployed to it. The backend can be held to a number of
// CPUs (`docker update --cpus`), as the live server's two vCPUs hold it.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { backendDir, root, x25519 } from '../lib.mjs'

/** The image a service runs in deploy/compose/compose.yml, so the test can't drift from what's deployed. */
export function composeImage(service, text = readFileSync(resolve(root, 'deploy/compose/compose.yml'), 'utf8')) {
  const block = text.match(new RegExp(`^  ${service}:\\n((?:    .*\\n|\\n)+)`, 'm'))
  const image = block?.[1].match(/^    image: (\S+)$/m)?.[1]
  if (!image) throw new Error(`deploy/compose/compose.yml has no image for ${service}.`)
  return image
}

/**
 * Runs docker. On the dev VM the agent shells aren't in the docker group, so `sg docker` is
 * used when plain docker can't reach the daemon (LOAD_DOCKER=sg forces it).
 */
let viaSg = process.env.LOAD_DOCKER === 'sg'
export function docker(args, { input, allowFail = false } = {}) {
  // Bounded, so a daemon that stops answering can't hold the run (or its clean-up) for good.
  const options = { input, encoding: 'utf8', timeout: 180_000 }
  const run = () =>
    viaSg
      ? spawnSync('sg', ['docker', '-c', ['docker', ...args].map(shellQuote).join(' ')], options)
      : spawnSync('docker', args, options)
  let result = run()
  if (!viaSg && result.status !== 0 && /permission denied.*docker/i.test(result.stderr ?? '')) {
    viaSg = true
    result = run()
  }
  if (result.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return (result.stdout ?? '').trim()
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

/** A port nothing on this machine listens on now. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const secret = () => randomBytes(32).toString('base64url')

async function waitFor(check, seconds, what) {
  const until = Date.now() + seconds * 1000
  let last
  while (Date.now() < until) {
    try {
      if (await check()) return
    } catch (error) {
      last = error
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${what} didn't come up within ${seconds}s${last ? `: ${last.message}` : ''}`)
}

/** How many executions the backend's function log keeps (MAX_UDF_EXECUTION). */
export const LOG_BUFFER = 200_000

const stackContainers = (name) => ({ postgres: `${name}-postgres`, backend: `${name}-backend` })

/** Removes a stack's containers, their volumes and its network, whatever of them exists. */
export function stopStack(name) {
  for (const c of Object.values(stackContainers(name))) docker(['rm', '-f', '-v', c], { allowFail: true })
  docker(['network', 'rm', `${name}-net`], { allowFail: true })
}

/**
 * The labels on a stack's network and containers: every one is the load test's, and one left
 * running on purpose (`--keep`) says so, so a later run leaves it alone.
 */
const labels = (keep) => [
  '--label',
  'trioditis.load-test=1',
  ...(keep ? ['--label', 'trioditis.load-test.keep=1'] : []),
]

/**
 * Removes stacks left by runs that are gone (killed, so they couldn't clean up), found by their
 * containers' and networks' labels: each is named for its run's process ID, and one whose
 * process isn't running is removed, unless it was kept on purpose.
 */
export function removeAbandonedStacks(log = console.log) {
  const list = (kind, filter) =>
    docker(
      [
        kind,
        'ls',
        ...(kind === 'container' ? ['-a'] : []),
        '--filter',
        filter,
        '--format',
        kind === 'container' ? '{{.Names}}' : '{{.Name}}',
      ],
      {
        allowFail: true,
      },
    )
      .split('\n')
      .filter(Boolean)
  const kept = new Set([
    ...list('container', 'label=trioditis.load-test.keep=1'),
    ...list('network', 'label=trioditis.load-test.keep=1'),
  ])
  const stackOf = (n) => n.match(/^(trioditis-load-\d+)-(?:backend|postgres|net)$/)?.[1]
  const stacks = new Set()
  for (const n of [
    ...list('container', 'label=trioditis.load-test=1'),
    ...list('network', 'label=trioditis.load-test=1'),
  ]) {
    const name = stackOf(n)
    if (name && !kept.has(n)) stacks.add(name)
  }
  for (const n of kept) stacks.delete(stackOf(n))
  for (const name of stacks) {
    const pid = Number(name.split('-').pop())
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      alive = error.code === 'EPERM'
    }
    if (alive) continue
    log(`Removing ${name}, left by a run that's gone`)
    stopStack(name)
  }
}

/**
 * Starts the stack and deploys the functions. `networks` are the ones the backend bridges
 * (TRIODITIS_NETWORKS). Returns what the rest of the test needs, and `stop()`.
 */
export async function startStack({ name, networks, keep = false, log = console.log }) {
  for (const file of ['.env', '.env.local']) {
    // The Convex CLI would read it and could deploy somewhere else (deploy-functions.sh refuses too).
    if (existsSync(resolve(backendDir, file))) {
      throw new Error(
        `packages/backend/${file} exists; the load test deploys with the Convex CLI, which would read it.`,
      )
    }
  }
  const images = { postgres: composeImage('postgres'), backend: composeImage('backend') }
  const net = `${name}-net`
  const containers = stackContainers(name)
  const stop = () => stopStack(name)
  stop()
  const pgPassword = secret()
  const instanceSecret = randomBytes(32).toString('hex')
  try {
    docker(['network', 'create', ...labels(keep), net])
    log(`Starting Postgres (${images.postgres.split('@')[0]})`)
    docker([
      'run',
      '-d',
      '--name',
      containers.postgres,
      '--network',
      net,
      '--network-alias',
      'postgres',
      '-e',
      'POSTGRES_USER=trioditis',
      '-e',
      `POSTGRES_PASSWORD=${pgPassword}`,
      '-e',
      'POSTGRES_DB=trioditis',
      ...labels(keep),
      images.postgres,
    ])
    await waitFor(
      () =>
        docker(['exec', containers.postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'trioditis'], {
          allowFail: true,
        }).includes('accepting'),
      60,
      'Postgres',
    )
    // install.sh's ensure_database: the backend's own database.
    await waitFor(
      () => {
        docker([
          'exec',
          containers.postgres,
          'psql',
          '-h',
          '127.0.0.1',
          '-U',
          'trioditis',
          '-d',
          'trioditis',
          '-qc',
          'CREATE DATABASE convex_self_hosted',
        ])
        return true
      },
      30,
      'The backend database',
    )

    log(`Starting the Convex backend (${images.backend.split('@')[0]})`)
    // Inside the container the backend serves 3210 (functions) and 3211 (HTTP actions) and
    // calls itself by those, as the live bundle calls itself through its public origin; the
    // host gets them on free ports, fixed so they stay the same across the restart that caps it.
    const ports = { cloud: await freePort(), site: await freePort() }
    docker([
      'run',
      '-d',
      '--name',
      containers.backend,
      '--network',
      net,
      '-p',
      `127.0.0.1:${ports.cloud}:3210`,
      '-p',
      `127.0.0.1:${ports.site}:3211`,
      '-e',
      `POSTGRES_URL=postgresql://trioditis:${pgPassword}@postgres:5432`,
      '-e',
      'DO_NOT_REQUIRE_SSL=1',
      '-e',
      'INSTANCE_NAME=convex-self-hosted',
      '-e',
      `INSTANCE_SECRET=${instanceSecret}`,
      '-e',
      'CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210',
      '-e',
      'CONVEX_SITE_ORIGIN=http://127.0.0.1:3211',
      '-e',
      'DISABLE_BEACON=true',
      '-e',
      'DISABLE_METRICS_ENDPOINT=true',
      '-e',
      'DOCUMENT_RETENTION_DELAY=172800',
      // The function log the report is made from keeps only the last 1,000 executions by
      // default; more, so none is dropped between two polls (logs.mjs checks it wasn't).
      '-e',
      `MAX_UDF_EXECUTION=${LOG_BUFFER}`,
      ...labels(keep),
      images.backend,
    ])
    const convexUrl = `http://127.0.0.1:${ports.cloud}`
    const siteUrl = `http://127.0.0.1:${ports.site}`
    await waitFor(async () => (await fetch(`${convexUrl}/version`)).ok, 120, 'The Convex backend')
    const adminKey = docker(['exec', containers.backend, './generate_admin_key.sh']).split('\n').pop().trim()
    if (!adminKey) throw new Error("Couldn't generate the Convex admin key.")

    const bridge = x25519()
    const agent = x25519()
    const env = {
      // What the backend calls itself, inside its container; the test sends this as Origin.
      SITE_URL: 'http://127.0.0.1:3211',
      BETTER_AUTH_SECRET: secret(),
      GATEWAY_SECRET: secret(),
      TRIODITIS_SETUP_TOKEN: secret(),
      TRIODITIS_NETWORKS: networks.join(','),
      BRIDGE_PUBLIC_KEY: bridge.publicKey,
      AGENT_ACCESS_PUBLIC_KEY: agent.publicKey,
      TRIODITIS_VERSION: 'load-test',
    }
    await deployFunctions({ convexUrl, adminKey, env, log })
    return {
      convexUrl,
      siteUrl,
      origin: env.SITE_URL,
      adminKey,
      gatewaySecret: env.GATEWAY_SECRET,
      setupToken: env.TRIODITIS_SETUP_TOKEN,
      containers,
      images,
      /**
       * Holds the backend to `cpus` CPUs, and restarts it so it sizes its thread pools for them,
       * as it does on a two-vCPU server, rather than for the host it was seeded on. Its data is
       * in Postgres, so nothing is lost.
       */
      capCpus: async (cpus) => {
        docker(['update', '--cpus', String(cpus), containers.backend])
        docker(['restart', containers.backend])
        await waitFor(async () => (await fetch(`${convexUrl}/version`)).ok, 120, 'The restarted backend')
      },
      databaseSize: () =>
        docker(
          [
            'exec',
            containers.postgres,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            'trioditis',
            '-d',
            'convex_self_hosted',
            '-tAc',
            "SELECT pg_size_pretty(pg_database_size('convex_self_hosted'))",
          ],
          { allowFail: true },
        ),
      stop,
    }
  } catch (error) {
    if (!keep) stop()
    throw error
  }
}

/**
 * The Convex CLI, run in packages/backend against this backend only: every other CONVEX_
 * variable is dropped, as deploy-functions.sh drops them.
 */
function convexCli(args, { convexUrl, adminKey, input }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CONVEX_') && k !== 'DOTENV_KEY'),
  )
  // Not spawnSync: a deploy takes a while, and Ctrl-C must still be able to clean up meanwhile.
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pnpm', ['exec', 'convex', ...args], {
      cwd: backendDir,
      env: { ...env, CONVEX_SELF_HOSTED_URL: convexUrl, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    // A CLI that exits before reading its input closes the pipe; its exit code says what failed.
    child.stdin.on('error', () => {})
    child.on('close', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`convex ${args[0]} failed:\n${out}`)),
    )
    child.stdin.end(input ?? '')
  })
}

/** What deploy/scripts/deploy-functions.sh does: the environment, the functions, then the migrations. */
async function deployFunctions({ convexUrl, adminKey, env, log }) {
  log('Deploying the functions')
  const input =
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  await convexCli(['env', 'set', '--force'], { convexUrl, adminKey, input })
  await convexCli(['deploy', '--typecheck', 'disable', '--codegen', 'disable', '--yes'], { convexUrl, adminKey })
  await convexCli(['run', 'migrations:runAll'], { convexUrl, adminKey })
}

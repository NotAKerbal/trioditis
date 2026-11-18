// Deploys the code in this working tree, committed or not, as a working demo instance on the
// internet: its own Convex preview backend plus a Vercel preview of the web app.
//
//   pnpm preview                 named after the current git branch
//   pnpm preview my-experiment   a name of your choice
//   pnpm preview --fresh         throw the preview's data away and start empty
//   pnpm preview --dry-run       print what it would do, and do nothing
//
// A preview is demo-only: it offers only the fake network, runs no bridge host, and gets made-up
// data (scripts/demo.mjs), so no real account or real message ever reaches Convex's cloud.
// Running it again with the same name updates that preview and keeps its data.
// Needs `npx convex login` and `npx vercel login` to have been done once on this machine.
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
  CLOUD_NETWORKS,
  TESTER,
  accounts,
  backendDir,
  capture,
  convexRef,
  ensureTester,
  root,
  run,
  step,
  x25519,
} from './lib.mjs'
import { seedDemo } from './demo.mjs'

const VERCEL_CLI = 'vercel@65.14.0'

const args = process.argv.slice(2)
const fresh = args.includes('--fresh')
const dryRun = args.includes('--dry-run')
const requested = args.find((arg) => !arg.startsWith('--'))
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true })
const name = (requested ?? branch)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40)
if (name.length < 3) {
  console.error('Give the preview a name of at least 3 letters or digits: pnpm preview <name>')
  process.exit(1)
}
if (!dryRun && (!accounts.vercelOrgId || !accounts.vercelWebProjectId)) {
  console.error(
    'Previews aren\'t set up yet: fill in accounts.vercelOrgId and accounts.vercelWebProjectId in scripts/lib.mjs (docs/CONTRIBUTING.md, "Setting it up").',
  )
  process.exit(1)
}
// Convex adds the `preview/` prefix to the reference of a preview deployment it creates.
const ref = convexRef(`preview/${name}`)

const convex = (...rest) => ['exec', 'convex', ...rest]
const convexEnv = (...rest) => convex('env', ...rest, '--deployment', ref)
const inBackend = { cwd: backendDir }

/** In a dry run, shows the command instead of running it. Later arguments can be secrets. */
function act(kind, cmd, cmdArgs, options = {}) {
  if (dryRun) {
    // A value being set is never shown: it can be a secret.
    const shown = cmdArgs.map((arg, i) => (cmdArgs[i - 2] === 'set' && cmdArgs[i - 3] === 'env' ? '<value>' : arg))
    console.log(`  would run: ${cmd} ${shown.join(' ')}`)
    return ''
  }
  return kind === 'run' ? run(cmd, cmdArgs, options) : capture(cmd, cmdArgs, options)
}

function backendExists() {
  if (dryRun) return false
  try {
    capture('pnpm', convexEnv('list'), { ...inBackend, quiet: true })
    return true
  } catch {
    return false
  }
}

step(`Backend: Convex deployment ${ref}${dryRun ? ' (dry run)' : ''}`)
if (fresh || !backendExists()) {
  act('run', 'pnpm', convex('deployment', 'create', convexRef(name), '--type', 'preview'), inBackend)
} else {
  console.log('Reusing the existing deployment and its data. Pass --fresh to start empty.')
}

// A temporary key lets `convex deploy` target this deployment without touching .env.local.
// Convex keys do not expire on their own, so it is deleted however this script ends.
const keyName = `preview-script-${Date.now()}`
let keyDeleted = dryRun
function deleteKey() {
  if (keyDeleted) return
  keyDeleted = true
  try {
    capture('pnpm', convex('deployment', 'token', 'delete', keyName, '--deployment', ref), {
      ...inBackend,
      quiet: true,
    })
  } catch {
    console.error(
      `\n\x1b[1mThe temporary deploy key "${keyName}" was not deleted.\x1b[0m Delete it now:\n` +
        `  cd packages/backend && pnpm exec convex deployment token delete ${keyName} --deployment ${ref}\n`,
    )
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    deleteKey()
    process.exit(1)
  })
}

let url = dryRun ? `https://trioditis-web-${name}.vercel.app` : null
let deploymentName = dryRun ? 'dry-run-deployment' : null
let deployKey = null
try {
  const keyOutput = act('capture', 'pnpm', convex('deployment', 'token', 'create', keyName, '--deployment', ref), {
    ...inBackend,
    quiet: true,
  })
  if (!dryRun) {
    deployKey = keyOutput.match(/[a-z]+:[a-z0-9-]+\|\S+/)?.[0] ?? null
    if (!deployKey) throw new Error('Could not read the deploy key from the Convex CLI output.')
    deploymentName = deployKey.slice(deployKey.indexOf(':') + 1, deployKey.indexOf('|'))
  }
  const convexUrl = `https://${deploymentName}.convex.cloud`
  const convexSiteUrl = `https://${deploymentName}.convex.site`

  step('Backend settings')
  const settings = dryRun ? '' : capture('pnpm', convexEnv('list'), { ...inBackend, quiet: true })
  const has = (variable) => new RegExp(`^${variable}=`, 'm').test(settings)
  const secret = () => randomBytes(32).toString('base64url')
  // A preview is demo-only: no real network, no bridge host. The gateway secret and bridge key
  // exist only because the backend expects them; nothing outside it ever holds them.
  const wanted = {
    BETTER_AUTH_SECRET: secret,
    // Sign-in needs a site URL before the real one is known; it is replaced below.
    SITE_URL: () => 'http://localhost:5173',
    GATEWAY_SECRET: secret,
    TRIODITIS_SETUP_TOKEN: secret,
    BRIDGE_PUBLIC_KEY: () => x25519().publicKey,
    AGENT_ACCESS_PUBLIC_KEY: () => x25519().publicKey,
  }
  for (const [variable, make] of Object.entries(wanted)) {
    if (!has(variable)) act('capture', 'pnpm', convexEnv('set', variable, make()), { ...inBackend, quiet: true })
  }
  if (!new RegExp(`^TRIODITIS_NETWORKS=${CLOUD_NETWORKS}$`, 'm').test(settings)) {
    act('capture', 'pnpm', convexEnv('set', 'TRIODITIS_NETWORKS', CLOUD_NETWORKS), { ...inBackend, quiet: true })
  }
  act('run', 'pnpm', convex('deploy', '--yes'), { ...inBackend, env: { CONVEX_DEPLOY_KEY: deployKey ?? '' } })

  step('Web app: Vercel preview')
  const deployOutput = act(
    'capture',
    'pnpm',
    [
      'dlx',
      VERCEL_CLI,
      'deploy',
      '--yes',
      '--archive=tgz',
      '--environment',
      'preview',
      '--scope',
      accounts.vercelScope,
      '--build-env',
      `VITE_CONVEX_URL=${convexUrl}`,
      '--build-env',
      `VITE_CONVEX_SITE_URL=${convexSiteUrl}`,
      // Tells scripts/vercel-build.mjs this is a preview, even when run from dev.
      '--build-env',
      `TRIODITIS_PREVIEW=${name}`,
      '--meta',
      `trioditisPreview=${name}`,
    ],
    // No git: Vercel matches a deploy's commit to the GitHub branch it is the tip of and hands
    // that branch's domain to it, so a preview from dev's tip would take over nightly's domain.
    // With GIT_DIR pointing at nothing, it sends no commit.
    {
      cwd: root,
      env: {
        VERCEL_ORG_ID: accounts.vercelOrgId ?? '',
        VERCEL_PROJECT_ID: accounts.vercelWebProjectId ?? '',
        GIT_DIR: resolve(root, '.no-git'),
      },
    },
  )
  if (!dryRun) {
    url = deployOutput.match(/https:\/\/[a-z0-9-]+\.vercel\.app/)?.[0]
    if (!url) throw new Error(`Could not find the preview URL in the Vercel CLI output:\n${String(deployOutput)}`)
  }

  step('Connecting sign-in to the preview URL')
  act('run', 'pnpm', convexEnv('set', 'SITE_URL', url), inBackend)
} finally {
  deleteKey()
}

if (dryRun) {
  console.log('\nThen: create the test account through the preview URL, and load the demo data. Nothing was done.')
  process.exit(0)
}

const convexRun = (fn, fnArgs) =>
  capture('pnpm', convex('run', fn, JSON.stringify(fnArgs), '--deployment', ref), { ...inBackend, quiet: true })
step('Creating the test account')
const setupToken = capture('pnpm', convexEnv('get', 'TRIODITIS_SETUP_TOKEN'), { ...inBackend, quiet: true })
const userId = await ensureTester({ authUrl: url, origin: url, setupToken })
step('Loading the demo data')
await seedDemo(convexRun, userId)

console.log(`
\x1b[1mPreview ready\x1b[0m
  URL       ${url}
  Email     ${TESTER.email}
  Password  ${TESTER.password}
  Backend   https://dashboard.convex.dev/d/${deploymentName}

Demo data only: the fake network, no bridge host. Convex removes the backend after a few days.`)

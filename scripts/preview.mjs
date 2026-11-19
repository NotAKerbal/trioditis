// Deploys the code in this working tree, committed or not, as a working demo instance on the
// internet: its own Convex preview backend plus a Vercel preview of the web app.
//
//   pnpm preview                 named after the current git branch
//   pnpm preview my-experiment   a name of your choice
//   pnpm preview --fresh         throw the preview's data away and start empty
//   pnpm preview --dry-run       check what's needed, print what it would do, and do nothing
//
// A preview is demo-only: it has no networks (no TRIODITIS_NETWORKS) and runs no bridge host,
// and its backend makes demo data for whoever signs up (TRIODITIS_DEMO=1, which also turns
// invitations off), so no real account or real message ever reaches Convex's cloud.
// Running it again with the same name updates that preview and keeps its data and secrets.
// Needs `npx convex login` and `npx vercel login` to have been done once on this machine.
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import {
  TESTER,
  accounts,
  backendDir,
  capture,
  cloudPrerequisites,
  convexRef,
  ensureTester,
  holdLock,
  removeConvexEnv,
  root,
  run,
  setConvexEnv,
  signInPassword,
  step,
  x25519,
} from './lib.mjs'
import { clientCrypto, seedTesterDemo, setUpTesterKeys, signInAsTester } from './demo.mjs'

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

// Everything is checked before anything is created or changed on either service.
const missing = cloudPrerequisites()
if (!accounts.vercelOrgId || !accounts.vercelWebProjectId) {
  missing.push(
    'accounts.vercelOrgId and accounts.vercelWebProjectId in scripts/lib.mjs (docs/CONTRIBUTING.md, "Setting it up")',
  )
}
const crypto = await clientCrypto().catch((error) => {
  missing.push(error.message)
  return null
})
if (missing.length > 0) {
  console.error(`\x1b[1mpnpm preview can't run yet. Missing:\x1b[0m\n  - ${missing.join('\n  - ')}`)
  if (!dryRun) process.exit(1)
  console.log('\nThe dry run goes on to show the steps.')
}

// One run per preview name at a time.
holdLock(`preview-${name}`)

// Convex adds the `preview/` prefix to the reference of a preview deployment it creates.
const ref = convexRef(`preview/${name}`)
const convex = (...rest) => ['exec', 'convex', ...rest]
const convexEnv = (...rest) => convex('env', ...rest, '--deployment', ref)
const inBackend = { cwd: backendDir }

/** In a dry run, shows the command instead of running it. */
function act(kind, cmd, cmdArgs, options = {}) {
  if (dryRun) {
    console.log(`  would run: ${cmd} ${cmdArgs.join(' ')}`)
    return ''
  }
  return kind === 'run' ? run(cmd, cmdArgs, options) : capture(cmd, cmdArgs, options)
}

/** Sets variables through stdin, so their values never appear in a process list. */
function setVariables(values) {
  if (Object.keys(values).length === 0) return
  if (dryRun) {
    console.log(`  would set: ${Object.keys(values).join(', ')} on ${ref}`)
    return
  }
  setConvexEnv(values, { ...inBackend, deployment: ref })
}

/** Unsets variables, like `setVariables`; one that isn't set stays unset. */
function removeVariables(variables) {
  if (variables.length === 0) return
  if (dryRun) {
    console.log(`  would remove: ${variables.join(', ')} on ${ref}`)
    return
  }
  removeConvexEnv(variables, { ...inBackend, deployment: ref })
}

function existingNames() {
  if (dryRun) return null
  try {
    return capture('pnpm', convexEnv('list', '--names-only'), { ...inBackend, quiet: true })
      .split(/\s+/)
      .filter(Boolean)
  } catch {
    return null
  }
}

step(`Backend: Convex deployment ${ref}${dryRun ? ' (dry run)' : ''}`)
let names = existingNames()
if (fresh || !names) {
  act('run', 'pnpm', convex('deployment', 'create', convexRef(name), '--type', 'preview'), inBackend)
  names = []
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
  // Only what's missing is set, so a rerun keeps the preview's secrets. The gateway secret and
  // bridge key exist only because the backend expects them: no bridge host connects to a
  // preview, and nothing outside the backend ever holds them.
  const secret = () => randomBytes(32).toString('base64url')
  const wanted = {
    BETTER_AUTH_SECRET: secret,
    // Sign-in needs a site URL before the real one is known; it is replaced below.
    SITE_URL: () => 'http://localhost:5173',
    GATEWAY_SECRET: secret,
    TRIODITIS_SETUP_TOKEN: secret,
    BRIDGE_PUBLIC_KEY: () => x25519().publicKey,
    AGENT_ACCESS_PUBLIC_KEY: () => x25519().publicKey,
  }
  const toSet = Object.fromEntries(
    Object.entries(wanted)
      .filter(([variable]) => !names.includes(variable))
      .map(([variable, make]) => [variable, make()]),
  )
  // Always: a preview is demo-only, whatever it held before. Demo data loads only on a backend
  // with no networks, and a preview made before networks were chosen in the app has some.
  toSet.TRIODITIS_DEMO = '1'
  setVariables(toSet)
  removeVariables(['TRIODITIS_NETWORKS'])
  act('run', 'pnpm', convex('deploy', '--yes'), { ...inBackend, env: { CONVEX_DEPLOY_KEY: deployKey ?? '' } })
  // A preview kept from before keeps its data, so its rows are caught up as a self-hosted
  // server's are (packages/backend/convex/migrations.ts).
  act('run', 'pnpm', convex('run', 'migrations:runAll'), {
    ...inBackend,
    env: { CONVEX_DEPLOY_KEY: deployKey ?? '' },
  })

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
      // Tells scripts/vercel-build.mjs this is a preview.
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
  setVariables({ SITE_URL: url })
} finally {
  deleteKey()
}

if (dryRun) {
  console.log(
    '\nThen: create the test account through the preview URL, set up its key, and load its demo data. Nothing was done.',
  )
  process.exit(0)
}

step('Creating the test account')
const setupToken = capture('pnpm', convexEnv('get', 'TRIODITIS_SETUP_TOKEN'), { ...inBackend, quiet: true })
const password = await signInPassword(TESTER.password, TESTER.email)
await ensureTester({ authUrl: url, origin: url, setupToken, password })
const { client, userId } = await signInAsTester(url, `https://${deploymentName}.convex.cloud`, password)
step('Setting up its key')
await setUpTesterKeys(crypto, client, userId)
step('Loading its demo data')
await seedTesterDemo(client)

console.log(`
\x1b[1mPreview ready\x1b[0m
  URL       ${url}
  Email     ${TESTER.email}
  Password  ${TESTER.password}
  Backend   https://dashboard.convex.dev/d/${deploymentName}

Demo data only: no networks, no bridge host, and no invitations. Convex removes the backend
after a few days.`)

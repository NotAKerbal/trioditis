// Runs the backend's migrations after a deploy, through their one entry point, the internal
// action migrations:runAll, which runs each in order; each is safe to run any number of times.
// Run by deploy-functions.sh in the functions job.
//
// It calls the bundle's backend directly over HTTP with the admin key, both from the job's
// environment, rather than through the Convex CLI, which rereads dotenv files and selector
// variables each time it starts and so could be pointed at another deployment.

import { createRequire } from 'node:module'

const backend = createRequire('/repo/packages/backend/package.json')
const { ConvexHttpClient } = backend('convex/browser')
const { makeFunctionReference } = backend('convex/server')

const url = process.env.CONVEX_SELF_HOSTED_URL
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY
if (!url || !adminKey) {
  console.error(
    'deploy-functions: CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are needed to run migrations',
  )
  process.exit(1)
}

const client = new ConvexHttpClient(url)
client.setAdminAuth(adminKey)
try {
  // Whether this backend has the entry point at all, from its own list of functions (what
  // `npx convex function-spec` reads): a backend from before runAll existed has none, and its
  // errors are redacted, so a failed call can't tell that apart from a failing migration.
  const functions = await client.query(makeFunctionReference('_system/cli/modules:apiSpec'), {})
  if (!functions.some((fn) => fn.identifier === 'migrations.js:runAll')) {
    console.log('deploy-functions: this backend has no migrations:runAll, so no migrations ran')
    process.exit(0)
  }
  // It waits for the first batch of each migration; later batches run in the background.
  await client.action(makeFunctionReference('migrations:runAll'), {})
  console.log('deploy-functions: migrations ran (migrations:runAll)')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`deploy-functions: migrations:runAll failed, so the install stops here: ${message}`)
  console.error(
    "The backend's log has the details (deploy/trioditis logs backend). Fix the cause and run the installer again.",
  )
  process.exit(1)
}

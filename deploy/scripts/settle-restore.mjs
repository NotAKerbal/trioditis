// After `deploy/trioditis restore`, before the gateway starts: makes every send the restored
// backup holds as still on its way `unknown`, so none goes out twice (gateway.settleAfterRestore
// in packages/backend, docs/deploy.md, Restore). install.sh runs it in the functions job's
// image, once the functions are deployed, while deploy/.restore-settle says a restore is waiting
// for it; RESTORE_BACKUP_AT is when the backup was taken, in milliseconds.
//
// Like run-migrations.mjs, it calls the bundle's backend directly with the admin key, both from
// the job's environment, so it can't be pointed at another deployment.

import { createRequire } from 'node:module'

const backend = createRequire('/repo/packages/backend/package.json')
const { ConvexHttpClient } = backend('convex/browser')
const { makeFunctionReference } = backend('convex/server')

const url = process.env.CONVEX_SELF_HOSTED_URL
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY
const backupAt = Number(process.env.RESTORE_BACKUP_AT)
if (!url || !adminKey || !Number.isSafeInteger(backupAt) || backupAt <= 0) {
  console.error('settle-restore: CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY and RESTORE_BACKUP_AT are needed')
  process.exit(1)
}

const client = new ConvexHttpClient(url)
client.setAdminAuth(adminKey)
try {
  // A backend without the function would leave every send in the backup free to go out again,
  // so that stops the restore rather than being skipped.
  const functions = await client.query(makeFunctionReference('_system/cli/modules:apiSpec'), {})
  if (!functions.some((fn) => fn.identifier === 'gateway.js:settleAfterRestore')) {
    console.error("settle-restore: this backend's functions can't settle a restore's sends (no gateway:settleAfterRestore)")
    process.exit(1)
  }
  let phase = 'scheduled'
  let cursor = null
  // Each call handles a bounded batch; far more calls than any install has rows means a loop.
  for (let calls = 0; phase !== null; calls++) {
    if (calls > 1_000_000) throw new Error('it never finished')
    ;({ phase, cursor } = await client.mutation(makeFunctionReference('gateway:settleAfterRestore'), {
      backupAt,
      phase,
      cursor,
    }))
  }
  console.log('settle-restore: sends from before the restore are settled')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`settle-restore: settling the restored sends failed, so the server stays stopped: ${message}`)
  process.exit(1)
}

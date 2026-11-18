import type { ErrorCode } from '@trioditis/core/bridge-protocol'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

// What a command's failure means to the person, beyond the outbox row: a logout that didn't
// happen. (A failed login command ends its session in gateway.ts.) `gateway.ts` calls these
// when the bridge host rejects a command or it expires undelivered; ingest calls `onLoggedOut`
// when a logout is confirmed.

async function failLogout(ctx: MutationCtx, command: Doc<'outbox'>, error: ErrorCode) {
  if (command.payload.type !== 'logout' || !command.loginId) return
  const loginId = command.loginId
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', command.network).eq('loginId', loginId))
    .unique()
  if (!account || account.userId !== command.userId) return
  await ctx.db.patch(account._id, { logoutPending: false, logoutError: error })
}

/** The bridge host refused the command as invalid (`commandResult` with `accepted: false`). */
export async function onCommandRejected(ctx: MutationCtx, command: Doc<'outbox'>, error: ErrorCode) {
  await failLogout(ctx, command, error)
}

/** The command ran out of time before a bridge host took it. */
export async function onCommandExpired(ctx: MutationCtx, command: Doc<'outbox'>) {
  await failLogout(ctx, command, 'expired')
}

/** The bridge host reports the account `LOGGED_OUT`: a pending logout is done. */
export async function onLoggedOut(ctx: MutationCtx, account: Doc<'networkAccounts'>) {
  if (account.logoutPending || account.logoutError) {
    await ctx.db.patch(account._id, { logoutPending: false, logoutError: undefined })
  }
}

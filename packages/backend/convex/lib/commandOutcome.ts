import type { ErrorCode } from '@trioditis/core/bridge-protocol'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { isMember } from './formerMembers'
import { queueLogout } from './outbox'

// What a command's failure means to the person, beyond the outbox row: a logout that didn't
// happen, or a new chat that won't come. (A failed login command ends its session in gateway.ts.) `gateway.ts` calls these
// when the bridge host rejects a command, it expires undelivered, or it was taken but never
// reported on; ingest calls `onLoggedOut` when a logout is confirmed.

async function failLogout(ctx: MutationCtx, command: Doc<'outbox'>, error: ErrorCode) {
  if (command.payload.type !== 'logout' || !command.loginId) return
  const loginId = command.loginId
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', command.network).eq('loginId', loginId))
    .unique()
  // Only the logout still waiting, and only by its own command: one already confirmed or
  // failed stays as it is, and an earlier logout's late outcome can't end a newer one.
  if (!account || account.userId !== command.userId || !account.logoutPending) return
  if (account.logoutCommandId !== undefined && account.logoutCommandId !== command._id) return
  await ctx.db.patch(account._id, { logoutPending: false, logoutError: error, logoutCommandId: undefined })
  // A removed member's account has nobody to try again: when the logout only ran out of time
  // (no bridge host took it, or one took it and went away), it is queued again. A bridge host
  // refusing it as invalid stays failed, shown to admins in Settings → Members (members.retryCleanup).
  if ((error === 'expired' || error === 'timeout') && !(await isMember(ctx, account.userId))) {
    await queueLogout(ctx, { ...account, logoutPending: false })
  }
}

/** A new chat whose command never ran won't come: its request ends with why. */
async function failChatStart(ctx: MutationCtx, command: Doc<'outbox'>, error: ErrorCode) {
  if (command.payload.type !== 'startChat') return
  const request = await ctx.db
    .query('chatStarts')
    .withIndex('by_command', (q) => q.eq('commandId', command._id))
    .unique()
  if (request?.state === 'pending') await ctx.db.patch(request._id, { state: 'failed', error })
}

/** The bridge host refused the command as invalid (`commandResult` with `accepted: false`). */
export async function onCommandRejected(ctx: MutationCtx, command: Doc<'outbox'>, error: ErrorCode) {
  await failLogout(ctx, command, error)
  await failChatStart(ctx, command, error)
}

/** The command ran out of time before a bridge host took it. */
export async function onCommandExpired(ctx: MutationCtx, command: Doc<'outbox'>) {
  await failLogout(ctx, command, 'expired')
  await failChatStart(ctx, command, 'expired')
}

/**
 * The bridge host took the command but never reported how it ended, well past its deadline
 * (it went away). A logout still pending then didn't visibly happen: the person can try again.
 */
export async function onCommandOverdue(ctx: MutationCtx, command: Doc<'outbox'>) {
  await failLogout(ctx, command, 'timeout')
  await failChatStart(ctx, command, 'timeout')
}

/** The bridge host reports the account `LOGGED_OUT`: a pending logout is done. */
export async function onLoggedOut(ctx: MutationCtx, account: Doc<'networkAccounts'>) {
  if (account.logoutPending || account.logoutError || account.logoutCommandId) {
    await ctx.db.patch(account._id, { logoutPending: false, logoutError: undefined, logoutCommandId: undefined })
  }
}

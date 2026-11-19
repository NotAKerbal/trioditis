import type { Infer } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { envelope } from '../validators'

// The outbox's bridge-readable payloads live in their own table (`outboxPayloads`), so
// scanning commands never reads ciphertext, and so deleting a payload is one place.

/** Login commands run while the person waits; one that hasn't gone out by then won't. */
export const LOGIN_COMMAND_TTL_MS = 10 * 60 * 1000

type Command = Omit<Doc<'outbox'>, '_id' | '_creationTime'>

/**
 * Queues a command, with its bridge-readable payload if it has one. A command with a deadline
 * is ended at that deadline by the scheduler (`gateway.commandDeadline`), not only by the
 * gateway's next claim: so its payload never outlives `expiresAt`, even with no gateway
 * running.
 */
export async function queueCommand(ctx: MutationCtx, command: Command, sealed?: Infer<typeof envelope>) {
  const deadline = command.expiresAt !== undefined
  const commandId = await ctx.db.insert('outbox', { ...command, ...(deadline ? { deadlineScheduled: true } : {}) })
  if (sealed) await ctx.db.insert('outboxPayloads', { commandId, sealed })
  if (deadline) await ctx.scheduler.runAt(command.expiresAt!, internal.gateway.commandDeadline, { commandId })
  return commandId
}

export async function commandPayload(ctx: QueryCtx, commandId: Id<'outbox'>) {
  return await ctx.db
    .query('outboxPayloads')
    .withIndex('by_command', (q) => q.eq('commandId', commandId))
    .unique()
}

/** Deletes a command's payload, returning it (for callers that meter what they read). */
export async function deletePayload(ctx: MutationCtx, commandId: Id<'outbox'>) {
  const payload = await commandPayload(ctx, commandId)
  if (payload) await ctx.db.delete(payload._id)
  return payload
}

/**
 * Asks the bridge host to log an account out of its network, unless it's out already or a
 * logout is on its way. Returns whether one was asked for.
 */
export async function queueLogout(ctx: MutationCtx, account: Doc<'networkAccounts'>) {
  if (account.state === 'LOGGED_OUT' || account.logoutPending) return false
  const now = Date.now()
  const logoutCommandId = await queueCommand(ctx, {
    userId: account.userId,
    network: account.network,
    loginId: account.loginId,
    payload: { type: 'logout' },
    state: 'queued',
    attempts: 0,
    createdAt: now,
    expiresAt: now + LOGIN_COMMAND_TTL_MS,
  })
  await ctx.db.patch(account._id, { logoutPending: true, logoutError: undefined, logoutCommandId })
  return true
}

/** Asks the bridge host to stop a login that hasn't finished. */
export async function queueLoginCancel(ctx: MutationCtx, session: Doc<'loginSessions'>) {
  const now = Date.now()
  await queueCommand(ctx, {
    userId: session.userId,
    network: session.network,
    payload: { type: 'loginCancel', loginSessionId: session._id },
    ...(session.hostId ? { hostId: session.hostId } : {}),
    state: 'queued',
    attempts: 0,
    createdAt: now,
    expiresAt: now + LOGIN_COMMAND_TTL_MS,
  })
}

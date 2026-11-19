import { v } from 'convex/values'
import type { Network } from '@trioditis/core'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, type MutationCtx } from './_generated/server'
import { refreshLast } from './lib/lastMessage'

// One-off fixes for rows written by an older version. Each is safe to run any number of times.
// `runAll` runs them all; `pnpm dev` and the self-hosted installer call it after every deploy,
// so a backend that keeps its data is always caught up (docs/CONTRIBUTING.md, Schema changes).

const BATCH = 100
/** The states a command can still be ended from; every other one is settled. */
const PENDING = ['queued', 'claimed', 'dispatched'] as const

/**
 * Schedules `gateway.commandDeadline` for every pending command with a deadline that was
 * queued before commands scheduled their own: with or without a bridge-readable payload, so
 * its payload is deleted on time and it ends (or is settled) on time too. It goes through
 * each pending state's commands by deadline, a batch at a time, carrying on until it has
 * been through them all: `npx convex run migrations:scheduleCommandDeadlines`.
 */
export const scheduleCommandDeadlines = internalMutation({
  args: { state: v.optional(v.number()), cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { state = 0, cursor }) => {
    const current = PENDING[state]
    if (!current) return null
    // From 0: a settled command has no `expiresAt`, which sorts before every number.
    const page = await ctx.db
      .query('outbox')
      .withIndex('by_expiry', (q) => q.eq('state', current).gte('expiresAt', 0))
      .paginate({ numItems: BATCH, cursor: cursor ?? null })
    for (const command of page.page) {
      if (command.expiresAt === undefined || command.deadlineScheduled) continue
      await ctx.db.patch(command._id, { deadlineScheduled: true })
      // A deadline already past runs now: the job checks the clock itself.
      await ctx.scheduler.runAt(Math.max(command.expiresAt, Date.now()), internal.gateway.commandDeadline, {
        commandId: command._id,
      })
    }
    const next = page.isDone ? { state: state + 1, cursor: null } : { state, cursor: page.continueCursor }
    if (PENDING[next.state]) await ctx.scheduler.runAfter(0, internal.migrations.scheduleCommandDeadlines, next)
    return null
  },
})

/**
 * How many chats one backfill batch goes through. Each may read its newest message, which can
 * be up to 768 KiB, so ten stay well inside a mutation's 16 MiB read limit.
 */
const LAST_BATCH = 10

/**
 * Gives every chat from before chats kept a pointer to their newest message (`chats.last`)
 * its pointer, a batch at a time, carrying on until it has been through them all. A chat
 * that has one already, `null` included, is left alone, so running it again changes nothing:
 * `npx convex run migrations:backfillChatLast`.
 */
export const backfillChatLast = internalMutation({
  args: { cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('chats').paginate({ numItems: LAST_BATCH, cursor: cursor ?? null })
    for (const chat of page.page) if (chat.last === undefined) await refreshLast(ctx, chat._id)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillChatLast, { cursor: page.continueCursor })
    }
    return null
  },
})

/** The fake network's name, which the schema's types no longer have (validators.ts, `storedNetwork`). */
const FAKE = 'fake' as Network

/**
 * Installs the networks people connected before admins installed networks themselves, so
 * those accounts keep working and people can reconnect them: each network with an account
 * that isn't logged out, unless an admin has decided on it already. A server that offered a
 * network nobody connected leaves it to the admins: `npx convex run migrations:installConnectedNetworks`.
 */
export const installConnectedNetworks = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const decided = new Set((await ctx.db.query('serverNetworks').collect()).map((row) => row.network))
    const now = Date.now()
    for (const account of await ctx.db.query('networkAccounts').collect()) {
      if (decided.has(account.network) || account.state === 'LOGGED_OUT' || account.network === FAKE) {
        continue
      }
      decided.add(account.network)
      await ctx.db.insert('serverNetworks', {
        network: account.network,
        installed: true,
        updatedAt: now,
        updatedBy: 'migration',
      })
    }
    return null
  },
})

/** How many rows one purge batch deletes, about. */
const PURGE_BATCH = 200

/**
 * Deletes everything on the fake network, the test network Trioditis no longer has: its
 * accounts, logins, chats with everything in them, contacts, commands and bridge hosts. It
 * starts from the accounts (every fake row belongs to someone who had one, the demo data
 * included), a batch at a time, carrying on until there's none left; each run finds what's
 * left by looking, so it needs no cursor: `npx convex run migrations:purgeFakeNetwork`.
 */
export const purgeFakeNetwork = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const budget = { left: PURGE_BATCH }
    const account = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', FAKE))
      .first()
    if (account) {
      if (await purgeFakeOf(ctx, account.userId, budget)) await ctx.db.delete(account._id)
    } else {
      // Logins that never made an account, and the hosts and anything they quarantined.
      for (const session of await ctx.db.query('loginSessions').collect()) {
        if (session.network === FAKE) await ctx.db.delete(session._id)
      }
      for (const host of await ctx.db.query('bridgeHosts').collect()) {
        if (host.network !== FAKE) continue
        const held = await ctx.db
          .query('quarantine')
          .withIndex('by_host', (q) => q.eq('hostId', host.hostId))
          .take(budget.left)
        for (const row of held) await ctx.db.delete(row._id)
        budget.left -= held.length
        if (budget.left > 0) await ctx.db.delete(host._id)
      }
      if (budget.left > 0) return null
    }
    await ctx.scheduler.runAfter(0, internal.migrations.purgeFakeNetwork, {})
    return null
  },
})

/** Deletes some of one person's fake-network rows, within the budget. True once there are none left. */
async function purgeFakeOf(ctx: MutationCtx, userId: string, budget: { left: number }) {
  const chats = await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', FAKE))
    .take(5)
  for (const chat of chats) {
    if (!(await purgeChat(ctx, chat._id, budget))) return false
    await ctx.db.delete(chat._id)
    budget.left--
  }
  if (chats.length === 5 || budget.left <= 0) return false
  const rows = [
    ...(await ctx.db
      .query('messages')
      .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(budget.left)),
    ...(await ctx.db
      .query('contacts')
      .withIndex('by_ghost', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(budget.left)),
    ...(await ctx.db
      .query('reactionEvents')
      .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(budget.left)),
  ]
  for (const row of rows) {
    if (budget.left <= 0) return false
    await ctx.db.delete(row._id)
    budget.left--
  }
  // Commands outside any chat: logins and logouts.
  const commands = await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', undefined))
    .collect()
  for (const command of commands) {
    if (command.userId !== userId || command.network !== FAKE) continue
    if (budget.left <= 0) return false
    await deleteCommand(ctx, command._id)
    budget.left--
  }
  for (const session of await ctx.db
    .query('loginSessions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()) {
    if (session.network === FAKE) await ctx.db.delete(session._id)
  }
  return budget.left > 0
}

async function deleteCommand(ctx: MutationCtx, commandId: Id<'outbox'>) {
  const payload = await ctx.db
    .query('outboxPayloads')
    .withIndex('by_command', (q) => q.eq('commandId', commandId))
    .unique()
  if (payload) await ctx.db.delete(payload._id)
  await ctx.db.delete(commandId)
}

/** Deletes what's in a chat, within the budget. True once nothing is left but the chat itself. */
async function purgeChat(ctx: MutationCtx, chatId: Id<'chats'>, budget: { left: number }) {
  const messages = await ctx.db
    .query('messages')
    .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
    .take(Math.max(budget.left, 0))
  for (const message of messages) {
    for (const reaction of await ctx.db
      .query('reactions')
      .withIndex('by_message', (q) => q.eq('messageId', message._id))
      .collect()) {
      await ctx.db.delete(reaction._id)
      budget.left--
    }
    for (const cleanup of await ctx.db
      .query('reactionCleanups')
      .withIndex('by_message', (q) => q.eq('messageId', message._id))
      .collect()) {
      await ctx.db.delete(cleanup._id)
    }
    await ctx.db.delete(message._id)
    budget.left--
  }
  if (budget.left <= 0) return false
  const rows = [
    ...(await ctx.db
      .query('receipts')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(budget.left)),
    ...(await ctx.db
      .query('typing')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(budget.left)),
    ...(await ctx.db
      .query('chatLabels')
      .withIndex('by_chat', (q) => q.eq('chatId', chatId))
      .take(budget.left)),
  ]
  for (const row of rows) {
    if (budget.left <= 0) return false
    await ctx.db.delete(row._id)
    budget.left--
  }
  for (const scheduled of await ctx.db
    .query('scheduledSends')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId))
    .take(Math.max(budget.left, 0))) {
    const payload = await ctx.db
      .query('scheduledPayloads')
      .withIndex('by_scheduled', (q) => q.eq('scheduledId', scheduled._id))
      .unique()
    if (payload) await ctx.db.delete(payload._id)
    await ctx.db.delete(scheduled._id)
    budget.left--
  }
  for (const command of await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId))
    .take(Math.max(budget.left, 0))) {
    await deleteCommand(ctx, command._id)
    budget.left--
  }
  return budget.left > 0
}

/**
 * Every migration, in order: the one entry point `pnpm dev` and the installer call. A new
 * migration must be added here as well as defined above, or it never runs on its own.
 */
export const runAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.migrations.scheduleCommandDeadlines, {})
    await ctx.runMutation(internal.migrations.backfillChatLast, {})
    await ctx.runMutation(internal.migrations.installConnectedNetworks, {})
    await ctx.runMutation(internal.migrations.purgeFakeNetwork, {})
    return null
  },
})

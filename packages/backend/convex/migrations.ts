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

/**
 * How many rows that can hold ciphertext (messages, payloads) one purge batch reads: a message
 * row can be 768 KiB, so eight stay far inside a mutation's 16 MiB read limit.
 */
const PURGE_LARGE = 8
/** How many small rows (reactions, receipts, contacts, sessions, commands) one batch reads. */
const PURGE_SMALL = 100

const purgePhase = v.union(v.literal('commands'), v.literal('hosts'))

/**
 * Deletes everything on the fake network, the test network Trioditis no longer has. First what
 * each person with a fake account had: the chats with everything in them, contacts, and then
 * the account. Then, everyone's together: logins, commands outside any chat, and the bridge
 * hosts with what they quarantined. Each batch deletes a bounded amount, commits, and
 * schedules the next; one that finds nothing moves on to the next phase, so it ends once all
 * of it is gone: `npx convex run migrations:purgeFakeNetwork`.
 */
export const purgeFakeNetwork = internalMutation({
  args: { phase: v.optional(purgePhase), cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { phase, cursor }) => {
    const next =
      phase === undefined
        ? await purgeAccounts(ctx)
        : phase === 'commands'
          ? await purgeCommands(ctx, cursor ?? null)
          : await purgeHosts(ctx)
    if (next) await ctx.scheduler.runAfter(0, internal.migrations.purgeFakeNetwork, next)
    return null
  },
})

type PurgeNext = { phase?: 'commands' | 'hosts'; cursor?: string | null } | null

async function purgeAccounts(ctx: MutationCtx): Promise<PurgeNext> {
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', FAKE))
    .first()
  if (!account) {
    const sessions = await ctx.db
      .query('loginSessions')
      .withIndex('by_network_state', (q) => q.eq('network', FAKE))
      .take(PURGE_SMALL)
    for (const session of sessions) await ctx.db.delete(session._id)
    return sessions.length ? {} : { phase: 'commands', cursor: null }
  }
  const userId = account.userId
  const chat = await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', FAKE))
    .first()
  if (chat) {
    if (!(await purgeChat(ctx, chat._id))) await ctx.db.delete(chat._id)
    return {}
  }
  // What's left outside any chat: messages whose chat is gone, contacts, reaction markers.
  const left = [
    ...(await ctx.db
      .query('messages')
      .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(PURGE_LARGE)),
    ...(await ctx.db
      .query('contacts')
      .withIndex('by_ghost', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(PURGE_SMALL)),
    ...(await ctx.db
      .query('reactionEvents')
      .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', FAKE))
      .take(PURGE_SMALL)),
  ]
  for (const row of left) await ctx.db.delete(row._id)
  if (!left.length) await ctx.db.delete(account._id)
  return {}
}

/** Deletes a batch of what's in a chat. True if it found any, false once only the chat is left. */
async function purgeChat(ctx: MutationCtx, chatId: Id<'chats'>) {
  const messages = await ctx.db
    .query('messages')
    .withIndex('by_chat_sort', (q) => q.eq('chatId', chatId))
    .take(PURGE_LARGE)
  for (const message of messages) {
    const reactions = await ctx.db
      .query('reactions')
      .withIndex('by_message', (q) => q.eq('messageId', message._id))
      .take(PURGE_SMALL)
    const cleanups = await ctx.db
      .query('reactionCleanups')
      .withIndex('by_message', (q) => q.eq('messageId', message._id))
      .take(PURGE_SMALL)
    for (const row of [...reactions, ...cleanups]) await ctx.db.delete(row._id)
    // A message with more reactions than one batch takes goes in a later one.
    if (reactions.length < PURGE_SMALL && cleanups.length < PURGE_SMALL) await ctx.db.delete(message._id)
  }
  if (messages.length) return true
  const small = [
    ...(await ctx.db
      .query('receipts')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(PURGE_SMALL)),
    ...(await ctx.db
      .query('typing')
      .withIndex('by_chat_sender', (q) => q.eq('chatId', chatId))
      .take(PURGE_SMALL)),
    ...(await ctx.db
      .query('chatLabels')
      .withIndex('by_chat', (q) => q.eq('chatId', chatId))
      .take(PURGE_SMALL)),
  ]
  for (const row of small) await ctx.db.delete(row._id)
  const scheduled = await ctx.db
    .query('scheduledSends')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId))
    .take(PURGE_LARGE)
  for (const row of scheduled) {
    const payload = await ctx.db
      .query('scheduledPayloads')
      .withIndex('by_scheduled', (q) => q.eq('scheduledId', row._id))
      .unique()
    if (payload) await ctx.db.delete(payload._id)
    await ctx.db.delete(row._id)
  }
  const commands = await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId))
    .take(PURGE_LARGE)
  for (const command of commands) await deleteCommand(ctx, command._id)
  return small.length + scheduled.length + commands.length > 0
}

/** Commands outside any chat (logins and logouts), everyone's, a page at a time. */
async function purgeCommands(ctx: MutationCtx, cursor: string | null): Promise<PurgeNext> {
  const page = await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', undefined))
    .paginate({ numItems: PURGE_SMALL, cursor })
  // Only a fake command's payload is read, and login payloads are small.
  for (const command of page.page) if (command.network === FAKE) await deleteCommand(ctx, command._id)
  return page.isDone ? { phase: 'hosts' } : { phase: 'commands', cursor: page.continueCursor }
}

/** The fake bridge hosts, after what they quarantined. */
async function purgeHosts(ctx: MutationCtx): Promise<PurgeNext> {
  const host = (await ctx.db.query('bridgeHosts').take(PURGE_SMALL)).find((row) => row.network === FAKE)
  if (!host) return null
  const held = await ctx.db
    .query('quarantine')
    .withIndex('by_host', (q) => q.eq('hostId', host.hostId))
    .take(PURGE_SMALL)
  for (const row of held) await ctx.db.delete(row._id)
  if (!held.length) await ctx.db.delete(host._id)
  return { phase: 'hosts' }
}

async function deleteCommand(ctx: MutationCtx, commandId: Id<'outbox'>) {
  const payload = await ctx.db
    .query('outboxPayloads')
    .withIndex('by_command', (q) => q.eq('commandId', commandId))
    .unique()
  if (payload) await ctx.db.delete(payload._id)
  await ctx.db.delete(commandId)
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

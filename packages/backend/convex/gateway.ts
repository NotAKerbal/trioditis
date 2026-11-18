import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { constantTimeEqual } from './lib/hash'
import { Unmappable, applyEvent } from './lib/ingest'
import { bridgeEvent, commandPayload, network } from './validators'

// The functions the gateway (apps/gateway) calls. Each takes the gateway's shared secret,
// GATEWAY_SECRET, so only the gateway can call them. See docs/architecture/bridge-protocol.md.

/** How long a gateway holds a command before another may take it. */
const LEASE_MS = 30_000
/** The most events one ingest call applies; the gateway splits bigger batches. */
export const MAX_BATCH = 100

function assertGateway(secret: string) {
  const expected = process.env.GATEWAY_SECRET
  if (!expected || !constantTimeEqual(secret, expected)) throw new ConvexError('Not the gateway')
}

/**
 * Applies a bridge host's events in order. Events at or below the host's last applied
 * sequence are replays and are skipped; a gap answers with the sequence the host must resend
 * from. Events that can't be applied are quarantined so they don't block the ones after.
 */
export const ingest = mutation({
  args: {
    secret: v.string(),
    hostId: v.string(),
    network,
    commandAddr: v.string(),
    events: v.array(bridgeEvent),
  },
  returns: v.union(v.object({ ackedThrough: v.number() }), v.object({ expectedSeq: v.number() })),
  handler: async (ctx, args) => {
    assertGateway(args.secret)
    if (args.events.length > MAX_BATCH) throw new ConvexError(`At most ${MAX_BATCH} events per batch`)
    const now = Date.now()
    let host = await ctx.db
      .query('bridgeHosts')
      .withIndex('by_hostId', (q) => q.eq('hostId', args.hostId))
      .unique()
    if (!host) {
      const hostId = await ctx.db.insert('bridgeHosts', {
        hostId: args.hostId,
        network: args.network,
        commandAddr: args.commandAddr,
        lastSeq: 0,
        updatedAt: now,
      })
      host = (await ctx.db.get(hostId))!
    }
    if (host.network !== args.network) throw new ConvexError(`Host ${args.hostId} is a ${host.network} host`)

    let lastSeq = host.lastSeq
    for (const event of args.events) {
      if (event.seq <= lastSeq) continue
      if (event.seq !== lastSeq + 1) {
        await ctx.db.patch(host._id, { lastSeq, commandAddr: args.commandAddr, updatedAt: now })
        return { expectedSeq: lastSeq + 1 }
      }
      try {
        await applyEvent(ctx, event, args.network)
      } catch (error) {
        if (!(error instanceof Unmappable)) throw error
        await ctx.db.insert('quarantine', {
          hostId: args.hostId,
          seq: event.seq,
          type: event.type,
          userId: event.userId,
          reason: error.message,
          at: now,
        })
      }
      lastSeq = event.seq
    }
    await ctx.db.patch(host._id, { lastSeq, commandAddr: args.commandAddr, updatedAt: now })
    return { ackedThrough: lastSeq }
  },
})

/**
 * What the bridge host seals a person's objects to. Null when the person has no identity key
 * yet, which the gateway answers with 409.
 */
export const recipientKeys = query({
  args: { secret: v.string(), userId: v.string() },
  returns: v.union(v.null(), v.object({ identityPublicKey: v.string(), agentGrantedPortals: v.array(v.string()) })),
  handler: async (ctx, { secret, userId }) => {
    assertGateway(secret)
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
    if (!member?.identityPublicKey) return null
    // Agent grants come with the agents work (Phase 4).
    return { identityPublicKey: member.identityPublicKey, agentGrantedPortals: [] }
  },
})

/** The bridge hosts that have reported in, and where each takes commands. */
export const hosts = query({
  args: { secret: v.string() },
  returns: v.array(v.object({ hostId: v.string(), network, commandAddr: v.string(), updatedAt: v.number() })),
  handler: async (ctx, { secret }) => {
    assertGateway(secret)
    const rows = await ctx.db.query('bridgeHosts').take(100)
    return rows.map(({ hostId, network, commandAddr, updatedAt }) => ({ hostId, network, commandAddr, updatedAt }))
  },
})

/**
 * Whether commands are waiting. The gateway subscribes to this and claims when it changes,
 * instead of polling.
 */
export const pendingCommands = query({
  args: { secret: v.string() },
  returns: v.object({ queued: v.number(), oldest: v.union(v.null(), v.number()) }),
  handler: async (ctx, { secret }) => {
    assertGateway(secret)
    const queued = await ctx.db
      .query('outbox')
      .withIndex('by_state', (q) => q.eq('state', 'queued'))
      .take(MAX_BATCH)
    return { queued: queued.length, oldest: queued[0]?.createdAt ?? null }
  },
})

/**
 * Whether `command` is next for its chat. Commands for one chat go out one at a time, in
 * order: an earlier one still queued or claimed holds it back, even with an expired lease,
 * because that one is claimed again first.
 */
async function isNextForChat(ctx: QueryCtx, command: Doc<'outbox'>) {
  if (!command.chatId) return true
  const chatId = command.chatId
  for (const state of ['queued', 'claimed'] as const) {
    const earlier = await ctx.db
      .query('outbox')
      .withIndex('by_chat', (q) => q.eq('chatId', chatId).eq('state', state).lt('createdAt', command.createdAt))
      .first()
    if (earlier && earlier._id !== command._id) return false
  }
  return true
}

async function expire(ctx: MutationCtx, command: Doc<'outbox'>) {
  await ctx.db.patch(command._id, {
    state: 'expired',
    delivery: 'failed',
    lastError: 'Not sent: it waited too long to go out. Send it again if you still want to.',
  })
  if (!command.clientMessageId) return
  const clientMessageId = command.clientMessageId
  const message = await ctx.db
    .query('messages')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', command.userId).eq('clientMessageId', clientMessageId))
    .first()
  if (message) await ctx.db.patch(message._id, { delivery: 'failed' })
}

/**
 * Leases up to `limit` commands to the calling gateway. A command whose lease ran out (its
 * gateway stopped) can be claimed again; the bridge host runs each `commandId` once, so
 * delivering it twice is safe.
 */
export const claimCommands = mutation({
  args: { secret: v.string(), limit: v.number() },
  returns: v.array(
    v.object({
      commandId: v.id('outbox'),
      userId: v.string(),
      network,
      loginId: v.optional(v.string()),
      payload: commandPayload,
    }),
  ),
  handler: async (ctx, { secret, limit }) => {
    assertGateway(secret)
    const now = Date.now()
    const take = Math.min(Math.max(1, limit), MAX_BATCH)
    const candidates = [
      ...(await ctx.db
        .query('outbox')
        .withIndex('by_state', (q) => q.eq('state', 'queued'))
        .take(take * 2)),
      ...(await ctx.db
        .query('outbox')
        .withIndex('by_state', (q) => q.eq('state', 'claimed'))
        .take(take * 2)),
    ].filter((command) => command.state === 'queued' || (command.leaseUntil ?? 0) <= now)

    const claimed = []
    for (const command of candidates.sort((a, b) => a.createdAt - b.createdAt)) {
      if (claimed.length >= take) break
      if (command.state === 'queued' && command.expiresAt !== undefined && command.expiresAt < now) {
        await expire(ctx, command)
        continue
      }
      if (!(await isNextForChat(ctx, command))) continue
      await ctx.db.patch(command._id, {
        state: 'claimed',
        leaseUntil: now + LEASE_MS,
        attempts: command.attempts + 1,
        ...(command.delivery === 'queued' ? { delivery: 'claimed' as const } : {}),
      })
      claimed.push({
        commandId: command._id,
        userId: command.userId,
        network: command.network,
        ...(command.loginId ? { loginId: command.loginId } : {}),
        payload: command.payload,
      })
    }
    return claimed
  },
})

/**
 * The bridge host's answer to a delivered command: accepted (queued durably) or rejected as
 * invalid. A command the gateway couldn't deliver at all gets no result; its lease runs out
 * and it is claimed again.
 */
export const commandResult = mutation({
  args: { secret: v.string(), commandId: v.id('outbox'), accepted: v.boolean(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { secret, commandId, accepted, error }) => {
    assertGateway(secret)
    const command = await ctx.db.get(commandId)
    if (!command || command.state !== 'claimed') return null
    if (accepted) {
      await ctx.db.patch(commandId, { state: 'dispatched', leaseUntil: undefined })
      return null
    }
    await ctx.db.patch(commandId, {
      state: 'rejected',
      leaseUntil: undefined,
      lastError: error ?? 'Rejected by the bridge host',
      ...(command.delivery ? { delivery: 'failed' as const } : {}),
    })
    if (command.clientMessageId) {
      const clientMessageId = command.clientMessageId
      const message = await ctx.db
        .query('messages')
        .withIndex('by_clientMessageId', (q) => q.eq('userId', command.userId).eq('clientMessageId', clientMessageId))
        .first()
      if (message) await ctx.db.patch(message._id, { delivery: 'failed' })
    }
    return null
  },
})

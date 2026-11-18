import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { constantTimeEqual } from './lib/hash'
import { Unmappable, applyEvent, byteSize, startMeter } from './lib/ingest'
import { commandPayload as payloadOf, deletePayload } from './lib/outbox'
import { bridgeEvent, commandPayload, envelope, errorCode, network } from './validators'

// The functions the gateway (apps/gateway) calls. Each takes the gateway's shared secret,
// GATEWAY_SECRET, so only the gateway can call them. See docs/architecture/bridge-protocol.md.

/** How long a gateway holds a command before it may be delivered again. */
const LEASE_MS = 30_000
/** A bridge host not heard from (events or heartbeat) for this long gets no commands. */
const HOST_STALE_MS = 2 * 60_000
/** The most events one ingest call applies; the gateway splits bigger batches. */
export const MAX_BATCH = 100
/**
 * The bytes one ingest call may touch before it stops early: far enough under Convex's
 * 16 MiB read and write limits that the last event applied can't cross them.
 */
const INGEST_BUDGET_BYTES = 6 * 1024 * 1024
/**
 * How many waiting commands one claim looks through to find chats that can go next. Outbox
 * rows hold no ciphertext (that's in `outboxPayloads`), so this stays well inside a
 * transaction's read limit.
 */
const SCAN = 2_000
const SCAN_EXPIRED_LEASES = 200
/** The most commands one claim hands out: each reads a payload of up to 64 KiB. */
const MAX_CLAIMS = 20
/**
 * How many commands one claim may expire. Expiring reads a payload and the person's copy
 * (each up to 64 KiB) and a login session, so it is bounded like claiming; the rest expire on
 * the next sweep.
 */
const MAX_EXPIRIES = 20
/**
 * The index lookups one claim may make beyond its two scans, kept well under Convex's
 * 4,096 ranges per transaction. A claim that runs out stops early; the next sweep goes on.
 */
const MAX_LOOKUPS = 3_000

const EVENT_TYPES = new Set([
  'message',
  'edit',
  'reaction',
  'reactionRemove',
  'redaction',
  'receipt',
  'typing',
  'chat',
  'contact',
  'loginState',
  'loginStep',
  'sendStatus',
  'backfillDone',
])

function assertGateway(secret: string) {
  const expected = process.env.GATEWAY_SECRET
  if (!expected || !constantTimeEqual(secret, expected)) throw new ConvexError('Not the gateway')
}

async function hostRow(ctx: QueryCtx, hostId: string) {
  return await ctx.db
    .query('bridgeHosts')
    .withIndex('by_hostId', (q) => q.eq('hostId', hostId))
    .unique()
}

async function registerHost(ctx: MutationCtx, hostId: string, hostNetwork: Doc<'bridgeHosts'>['network'], now: number) {
  if (hostId.length > 64) throw new ConvexError('Host ID too long')
  const existing = await hostRow(ctx, hostId)
  if (existing) {
    if (existing.network !== hostNetwork) throw new ConvexError('Host network mismatch')
    return existing
  }
  const id = await ctx.db.insert('bridgeHosts', { hostId, network: hostNetwork, lastSeq: 0, lastSeenAt: now })
  return (await ctx.db.get(id))!
}

/**
 * Applies a bridge host's events in order. Events at or below the host's last applied
 * sequence are replays and are skipped; a gap answers with the sequence the host must resend
 * from, after committing everything before it. Events that can't be applied are quarantined
 * so they don't block the ones after. An empty batch is the host's heartbeat.
 */
export const ingest = mutation({
  args: {
    secret: v.string(),
    hostId: v.string(),
    network,
    events: v.array(bridgeEvent),
  },
  returns: v.union(v.object({ ackedThrough: v.number() }), v.object({ expectedSeq: v.number() })),
  handler: async (ctx, args) => {
    assertGateway(args.secret)
    if (args.events.length > MAX_BATCH) throw new ConvexError('Batch too large')
    const now = Date.now()
    const host = await registerHost(ctx, args.hostId, args.network, now)

    let lastSeq = host.lastSeq
    let gap: number | null = null
    let applied = 0
    const meter = startMeter(ctx)
    for (const event of args.events) {
      if (event.seq <= lastSeq) continue
      // Stop early, acknowledging what's applied, before the call could exceed Convex's
      // transaction limits; the gateway sends the rest in its next call.
      if (applied > 0 && meter.bytes > INGEST_BUDGET_BYTES) break
      if (event.seq !== lastSeq + 1) {
        gap = lastSeq + 1
        break
      }
      try {
        await applyEvent(ctx, event, { network: args.network, hostId: args.hostId })
      } catch (error) {
        if (!(error instanceof Unmappable)) throw error
        await ctx.db.insert('quarantine', {
          hostId: args.hostId,
          seq: event.seq,
          type: event.type,
          userId: event.userId,
          reason: error.reason,
          at: now,
        })
      }
      lastSeq = event.seq
      applied++
      meter.bytes += 2 * byteSize(event)
    }
    await ctx.db.patch(host._id, { lastSeq, lastSeenAt: now })
    return gap === null ? { ackedThrough: lastSeq } : { expectedSeq: gap }
  },
})

/**
 * Records an event the backend's validators refuse, so one malformed journal entry doesn't
 * stop every event after it. Only the next expected sequence can be skipped this way.
 */
export const quarantineInvalid = mutation({
  args: { secret: v.string(), hostId: v.string(), network, seq: v.number(), type: v.string() },
  returns: v.union(v.object({ ackedThrough: v.number() }), v.object({ expectedSeq: v.number() })),
  handler: async (ctx, args) => {
    assertGateway(args.secret)
    const now = Date.now()
    const host = await registerHost(ctx, args.hostId, args.network, now)
    if (args.seq <= host.lastSeq) return { ackedThrough: host.lastSeq }
    if (args.seq !== host.lastSeq + 1) return { expectedSeq: host.lastSeq + 1 }
    await ctx.db.insert('quarantine', {
      hostId: args.hostId,
      seq: args.seq,
      // Only a known event type is kept; anything else could be arbitrary text.
      type: EVENT_TYPES.has(args.type) ? args.type : 'unknown',
      userId: '',
      reason: 'invalid_event',
      at: now,
    })
    await ctx.db.patch(host._id, { lastSeq: args.seq, lastSeenAt: now })
    return { ackedThrough: args.seq }
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

/**
 * Whether commands are waiting. The gateway subscribes to this and claims when it changes,
 * instead of polling.
 */
export const pendingCommands = query({
  args: { secret: v.string() },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, { secret }) => {
    assertGateway(secret)
    const queued = await ctx.db
      .query('outbox')
      .withIndex('by_state', (q) => q.eq('state', 'queued'))
      .take(MAX_BATCH)
    return { queued: queued.length }
  },
})

/**
 * Whether `command` is next for its chat. Commands for one chat go out one at a time, in the
 * order they were created (`_creationTime`, unique per row, so two in the same millisecond
 * still have an order): another claimed command holds the chat, and so does an earlier one
 * still queued.
 */
async function isNextForChat(ctx: QueryCtx, command: Doc<'outbox'>) {
  if (!command.chatId) return true
  const chatId = command.chatId
  const claimed = await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId).eq('state', 'claimed'))
    .first()
  if (claimed && claimed._id !== command._id) return false
  const firstQueued = await ctx.db
    .query('outbox')
    .withIndex('by_chat', (q) => q.eq('chatId', chatId).eq('state', 'queued'))
    .first()
  return !firstQueued || firstQueued._creationTime >= command._creationTime
}

async function markCopy(ctx: MutationCtx, command: Doc<'outbox'>, delivery: 'failed' | 'unknown') {
  if (!command.clientMessageId) return
  const clientMessageId = command.clientMessageId
  const message = await ctx.db
    .query('messages')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', command.userId).eq('clientMessageId', clientMessageId))
    .first()
  if (message && message.eventId.startsWith('pending:')) await ctx.db.patch(message._id, { delivery })
}

/**
 * A login whose command ran out of time ends with an error the person can start again from,
 * but only if that command is still what the login is waiting on: an old submission for a
 * step the login has moved past changes nothing. A cancel that never arrived still cancels
 * here, as the person asked.
 */
async function expireLogin(ctx: MutationCtx, command: Doc<'outbox'>) {
  const { payload } = command
  if (payload.type !== 'loginStart' && payload.type !== 'loginSubmit' && payload.type !== 'loginCancel') return
  const sessionId = ctx.db.normalizeId('loginSessions', payload.loginSessionId)
  const session = sessionId ? await ctx.db.get(sessionId) : null
  if (!session || session.state === 'complete' || session.state === 'cancelled') return
  const now = Date.now()
  if (payload.type === 'loginCancel') {
    await ctx.db.patch(session._id, { state: 'cancelled', updatedAt: now })
    return
  }
  const waitingOnIt =
    payload.type === 'loginStart'
      ? session.state === 'pending'
      : session.state === 'active' && session.step?.stepId === payload.stepId
  if (!waitingOnIt) return
  await ctx.db.patch(session._id, {
    state: 'error',
    step: { stepId: 'expired', type: 'error', error: 'expired' },
    updatedAt: now,
  })
}

/**
 * Ends a command that ran out of time. A send never handed out wasn't sent: `failed`. One
 * handed out whose acceptance was never confirmed may have reached the bridge host:
 * `unknown`, and the person decides. (The bridge host itself won't send after `notAfter`.)
 */
async function expire(ctx: MutationCtx, command: Doc<'outbox'>) {
  const delivery = command.state === 'queued' ? 'failed' : 'unknown'
  await ctx.db.patch(command._id, {
    state: 'expired',
    leaseUntil: undefined,
    lastError: 'expired',
    ...(command.delivery ? { delivery } : {}),
  })
  await deletePayload(ctx, command._id)
  await markCopy(ctx, command, delivery)
  await expireLogin(ctx, command)
}

/**
 * Leases up to `limit` commands to the gateway, each with the bridge host to deliver it to.
 * Only hosts the gateway can reach (`hostIds`, from its configuration) that have been heard
 * from recently get commands. A command for a connected login goes to the host running that
 * login; a new login goes to the network's most recently seen host. A command that may
 * already have reached a host goes back only to that host, whose journal knows its ID, so it
 * runs at most once.
 */
export const claimCommands = mutation({
  args: { secret: v.string(), limit: v.number(), hostIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      commandId: v.id('outbox'),
      lease: v.number(),
      hostId: v.string(),
      userId: v.string(),
      network,
      loginId: v.optional(v.string()),
      payload: commandPayload,
      sealed: v.optional(envelope),
      notAfter: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { secret, limit, hostIds }) => {
    assertGateway(secret)
    const now = Date.now()
    const take = Math.min(Math.max(1, Math.floor(limit)), MAX_CLAIMS)
    let lookups = 0
    const reachable = new Set(hostIds)

    const liveHosts = new Map<string, Doc<'bridgeHosts'>>()
    const liveByNetwork = new Map<string, Doc<'bridgeHosts'>>()
    for (const host of await ctx.db.query('bridgeHosts').take(100)) {
      if (!reachable.has(host.hostId) || now - host.lastSeenAt > HOST_STALE_MS) continue
      liveHosts.set(host.hostId, host)
      const current = liveByNetwork.get(host.network)
      if (!current || host.lastSeenAt > current.lastSeenAt) liveByNetwork.set(host.network, host)
    }
    const loginHosts = new Map<string, string | undefined>()
    async function hostFor(command: Doc<'outbox'>) {
      if (command.hostId) return liveHosts.get(command.hostId)
      if (!command.loginId) return liveByNetwork.get(command.network)
      const key = `${command.network}:${command.loginId}`
      if (!loginHosts.has(key)) {
        lookups += 1
        const loginId = command.loginId
        const account = await ctx.db
          .query('networkAccounts')
          .withIndex('by_login', (q) => q.eq('network', command.network).eq('loginId', loginId))
          .unique()
        loginHosts.set(key, account?.hostId)
      }
      const owner = loginHosts.get(key)
      return owner ? liveHosts.get(owner) : undefined
    }

    const candidates = [
      ...(await ctx.db
        .query('outbox')
        .withIndex('by_lease', (q) => q.eq('state', 'claimed').lte('leaseUntil', now))
        .take(SCAN_EXPIRED_LEASES)),
      ...(await ctx.db
        .query('outbox')
        .withIndex('by_state', (q) => q.eq('state', 'queued'))
        .take(SCAN)),
    ].sort((a, b) => a._creationTime - b._creationTime)

    const claimed = []
    const heldChats = new Set<Id<'chats'>>()
    let expired = 0
    for (const command of candidates) {
      if (claimed.length >= take || lookups >= MAX_LOOKUPS) break
      if (command.expiresAt !== undefined && command.expiresAt <= now) {
        if (expired < MAX_EXPIRIES) {
          lookups += 3
          await expire(ctx, command)
          expired++
        }
        continue
      }
      const host = await hostFor(command)
      if (!host) continue
      if (command.chatId) {
        if (heldChats.has(command.chatId)) continue
        heldChats.add(command.chatId)
        lookups += 2
        if (!(await isNextForChat(ctx, command))) continue
      }
      lookups += 2
      const lease = command.attempts + 1
      await ctx.db.patch(command._id, {
        state: 'claimed',
        leaseUntil: now + LEASE_MS,
        attempts: lease,
        hostId: host.hostId,
        ...(command.delivery === 'queued' ? { delivery: 'claimed' as const } : {}),
      })
      // A new login runs on the host it starts on, so only that host speaks for it.
      if (command.payload.type === 'loginStart') {
        const sessionId = ctx.db.normalizeId('loginSessions', command.payload.loginSessionId)
        const session = sessionId ? await ctx.db.get(sessionId) : null
        if (session && !session.hostId) await ctx.db.patch(session._id, { hostId: host.hostId })
      }
      const payload = await payloadOf(ctx, command._id)
      claimed.push({
        commandId: command._id,
        lease,
        hostId: host.hostId,
        userId: command.userId,
        network: command.network,
        ...(command.loginId ? { loginId: command.loginId } : {}),
        payload: command.payload,
        ...(payload ? { sealed: payload.sealed } : {}),
        ...(command.expiresAt !== undefined ? { notAfter: command.expiresAt } : {}),
      })
    }
    return claimed
  },
})

/**
 * The bridge host's answer to a delivered command: accepted (queued durably) or rejected as
 * invalid. Only the answer to the command's current lease counts. A command the gateway
 * couldn't deliver gets no result; its lease runs out and it is claimed again.
 */
export const commandResult = mutation({
  args: {
    secret: v.string(),
    commandId: v.id('outbox'),
    lease: v.number(),
    accepted: v.boolean(),
    error: v.optional(errorCode),
  },
  returns: v.null(),
  handler: async (ctx, { secret, commandId, lease, accepted, error }) => {
    assertGateway(secret)
    const command = await ctx.db.get(commandId)
    if (!command || command.state !== 'claimed' || command.attempts !== lease) return null
    await deletePayload(ctx, commandId)
    if (accepted) {
      await ctx.db.patch(commandId, { state: 'dispatched', leaseUntil: undefined })
      return null
    }
    await ctx.db.patch(commandId, {
      state: 'rejected',
      leaseUntil: undefined,
      lastError: error ?? 'invalid_command',
      ...(command.delivery ? { delivery: 'failed' as const } : {}),
    })
    await markCopy(ctx, command, 'failed')
    return null
  },
})

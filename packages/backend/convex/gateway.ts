import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { constantTimeEqual, sha256Hex } from './lib/hash'
import { onCommandExpired, onCommandOverdue, onCommandRejected } from './lib/commandOutcome'
import { byteSize } from './lib/bounded'
import { Unmappable, applyEvent, startMeter } from './lib/ingest'
import { commandPayload as payloadOf, deletePayload } from './lib/outbox'
import { bridgedNetworks } from './lib/networks'
import { browserStepOpen } from './logins'
import { sendScheduled } from './scheduled'
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
/** What still goes out for someone no longer a member: what tears their network accounts down. */
const TEARDOWN = new Set(['logout', 'loginCancel'])
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
  'contactIdentifiers',
  'chatStarted',
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
    /** The host's last heartbeat before it shuts down: it is offline from now. */
    stopping: v.optional(v.boolean()),
  },
  returns: v.union(v.object({ ackedThrough: v.number() }), v.object({ expectedSeq: v.number() })),
  handler: async (ctx, args) => {
    assertGateway(args.secret)
    if (args.events.length > MAX_BATCH) throw new ConvexError('Batch too large')
    // Only networks this server runs a bridge host for, installed by an admin or not: a
    // network that was removed keeps its accounts until their logouts land, and what arrives
    // for them meanwhile is theirs. A demo deployment runs none, so it never stores events
    // from a network, whoever holds the gateway secret.
    if (!bridgedNetworks().has(args.network)) throw new ConvexError('Network not enabled')
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
          // An ID too long to be one is what got this event quarantined; it isn't kept.
          userId: event.userId.length <= 256 ? event.userId : '',
          reason: error.reason,
          at: now,
        })
      }
      lastSeq = event.seq
      applied++
      meter.bytes += 2 * byteSize(event)
    }
    // A host that says it is stopping is offline at once (never heard from, as far as being
    // live goes), rather than once its heartbeats have gone stale.
    const stopping = args.stopping === true && args.events.length === 0
    await ctx.db.patch(host._id, { lastSeq, lastSeenAt: stopping ? 0 : now })
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
async function expire(
  ctx: MutationCtx,
  command: Doc<'outbox'>,
  delivery: 'failed' | 'unknown' = command.state === 'queued' ? 'failed' : 'unknown',
) {
  await ctx.db.patch(command._id, {
    state: 'expired',
    leaseUntil: undefined,
    lastError: 'expired',
    ...(command.delivery ? { delivery } : {}),
  })
  await deletePayload(ctx, command._id)
  await markCopy(ctx, command, delivery)
  await expireLogin(ctx, command)
  await onCommandExpired(ctx, command)
}

/** How long after its deadline a command the bridge host accepted may go without an outcome. */
const OVERDUE_GRACE_MS = 60 * 60 * 1000

/**
 * A command the bridge host accepted but never reported on (it went away) would wait forever.
 * Once well past its deadline, a send becomes `unknown`, so the person can choose; it is never
 * sent again, and a late outcome from the bridge host still settles it. A login still waiting
 * on the command ends with `expired`, so the person can start it again, and a logout still
 * pending stops being pending, with `timeout`.
 */
async function settleOverdue(ctx: MutationCtx, now: number) {
  const overdue = await ctx.db
    .query('outbox')
    // From 0: a send settled here has no `expiresAt`, which sorts before every number, so
    // without a lower bound the same settled rows would fill every scan.
    .withIndex('by_expiry', (q) =>
      q
        .eq('state', 'dispatched')
        .gte('expiresAt', 0)
        .lte('expiresAt', now - OVERDUE_GRACE_MS),
    )
    .take(MAX_EXPIRIES)
  for (const command of overdue) await settle(ctx, command)
}

/** Settles one overdue command; it then has no `expiresAt`, so nothing settles it twice. */
async function settle(ctx: MutationCtx, command: Doc<'outbox'>) {
  const unsettled = command.delivery === 'queued' || command.delivery === 'claimed' || command.delivery === 'submitted'
  await ctx.db.patch(command._id, { expiresAt: undefined, ...(unsettled ? { delivery: 'unknown' as const } : {}) })
  if (unsettled) await markCopy(ctx, command, 'unknown')
  await expireLogin(ctx, command)
  await onCommandOverdue(ctx, command)
}

/**
 * Runs at a command's deadline, scheduled when it was queued, so a command ends on time even
 * when no gateway is claiming. At the deadline its bridge-readable payload is deleted, and:
 * one still queued expires; one claimed expires once its lease is over too (until then the
 * gateway may be handing it over, and its result for that lease still counts, as it would
 * have before the deadline); one the bridge host accepted is settled an hour later if it never
 * reported back. The gateway's own sweep does the same; whichever runs first wins, and the
 * other finds nothing left to do.
 */
export const commandDeadline = internalMutation({
  args: { commandId: v.id('outbox') },
  returns: v.null(),
  handler: async (ctx, { commandId }) => {
    const command = await ctx.db.get(commandId)
    if (!command) return null
    const now = Date.now()
    const later = async (at: number) => await ctx.scheduler.runAt(at, internal.gateway.commandDeadline, { commandId })
    // Run early (as a migration may), it waits for the deadline: a claim before then still
    // needs the payload.
    if (command.expiresAt !== undefined && command.expiresAt > now) {
      await later(command.expiresAt)
      return null
    }
    // Past the deadline, whatever state it's in, nothing bridge-readable stays.
    await deletePayload(ctx, commandId)
    if (command.expiresAt === undefined) return null
    if (command.state === 'queued') {
      await expire(ctx, command)
    } else if (command.state === 'claimed') {
      if (command.leaseUntil !== undefined && command.leaseUntil > now) await later(command.leaseUntil)
      else await expire(ctx, command)
    } else if (command.state === 'dispatched') {
      const overdueAt = command.expiresAt + OVERDUE_GRACE_MS
      if (overdueAt <= now) await settle(ctx, command)
      else await later(overdueAt)
    }
    return null
  },
})

/** A login command the bridge host refused ends that login with its error. */
async function failLogin(ctx: MutationCtx, command: Doc<'outbox'>, error: Doc<'outbox'>['lastError']) {
  const { payload } = command
  if (payload.type !== 'loginStart' && payload.type !== 'loginSubmit' && payload.type !== 'loginCancel') return
  const sessionId = ctx.db.normalizeId('loginSessions', payload.loginSessionId)
  const session = sessionId ? await ctx.db.get(sessionId) : null
  if (!session || session.state === 'complete' || session.state === 'cancelled' || session.state === 'error') return
  // Only while the login still waits on this command: a refused duplicate of a step it has
  // moved past mustn't end it.
  if (payload.type === 'loginStart' && session.state !== 'pending') return
  if (payload.type === 'loginSubmit' && !(session.state === 'active' && session.step?.stepId === payload.stepId)) return
  await ctx.db.patch(session._id, {
    state: 'error',
    step: { stepId: 'rejected', type: 'error', error: error ?? 'invalid_command' },
    updatedAt: Date.now(),
  })
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
    // The gateway's configured hosts, looked up directly, however many others have come and gone.
    for (const hostId of [...reachable].slice(0, 100)) {
      const host = await hostRow(ctx, hostId)
      if (!host || now - host.lastSeenAt > HOST_STALE_MS) continue
      liveHosts.set(host.hostId, host)
      const current = liveByNetwork.get(host.network)
      if (!current || host.lastSeenAt > current.lastSeenAt) liveByNetwork.set(host.network, host)
    }
    const members = new Map<string, boolean>()
    async function stillMember(userId: string) {
      if (!members.has(userId)) {
        lookups += 1
        const member = await ctx.db
          .query('members')
          .withIndex('by_userId', (q) => q.eq('userId', userId))
          .unique()
        members.set(userId, member !== null)
      }
      return members.get(userId)!
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

    await settleOverdue(ctx, now)

    // Queued commands are scanned a window at a time, carrying on from where the last claim
    // stopped and wrapping round, so commands that can't go out yet (their host is down) never
    // keep everything behind them waiting.
    const cursor = await ctx.db
      .query('claimCursor')
      .withIndex('by_key', (q) => q.eq('key', 'queued'))
      .unique()
    const after = cursor?.after ?? 0
    let queued = await ctx.db
      .query('outbox')
      .withIndex('by_state', (q) => q.eq('state', 'queued').gt('_creationTime', after))
      .take(SCAN)
    let nextAfter = queued.at(-1)?._creationTime ?? 0
    if (queued.length < SCAN && after > 0) {
      const wrapped = await ctx.db
        .query('outbox')
        .withIndex('by_state', (q) => q.eq('state', 'queued').lte('_creationTime', after))
        .take(SCAN - queued.length)
      queued = [...wrapped, ...queued]
      nextAfter = 0
    } else if (queued.length < SCAN) {
      nextAfter = 0
    }
    if (cursor) await ctx.db.patch(cursor._id, { after: nextAfter })
    else await ctx.db.insert('claimCursor', { key: 'queued', after: nextAfter })

    // Expired leases the same way: those pinned to a host that's down mustn't hide the rest.
    // The cursor is a deadline and a creation time, since many leases can share a deadline.
    const leaseCursor = await ctx.db
      .query('claimCursor')
      .withIndex('by_key', (q) => q.eq('key', 'leases'))
      .unique()
    const leaseAt = Math.min(leaseCursor?.after ?? 0, now)
    const leaseTie = leaseCursor?.afterCreation ?? 0
    const leaseRows = new Map<Id<'outbox'>, Doc<'outbox'>>()
    const addLeases = (rows: Doc<'outbox'>[]) => rows.forEach((row) => leaseRows.set(row._id, row))
    if (leaseAt > 0) {
      addLeases(
        await ctx.db
          .query('outbox')
          .withIndex('by_lease', (q) =>
            q.eq('state', 'claimed').eq('leaseUntil', leaseAt).gt('_creationTime', leaseTie),
          )
          .take(SCAN_EXPIRED_LEASES),
      )
    }
    addLeases(
      await ctx.db
        .query('outbox')
        .withIndex('by_lease', (q) => q.eq('state', 'claimed').gt('leaseUntil', leaseAt).lte('leaseUntil', now))
        .take(SCAN_EXPIRED_LEASES - leaseRows.size),
    )
    const pastCursor = [...leaseRows.values()]
    const last = pastCursor.at(-1)
    let nextLease = { after: last?.leaseUntil ?? 0, afterCreation: last?._creationTime ?? 0 }
    if (leaseRows.size < SCAN_EXPIRED_LEASES) {
      // Round again from the start, up to where this scan began.
      if (leaseAt > 0) {
        addLeases(
          await ctx.db
            .query('outbox')
            .withIndex('by_lease', (q) => q.eq('state', 'claimed').lte('leaseUntil', leaseAt))
            .take(SCAN_EXPIRED_LEASES - leaseRows.size),
        )
      }
      nextLease = { after: 0, afterCreation: 0 }
    }
    const leases = [...leaseRows.values()]
    if (leaseCursor) await ctx.db.patch(leaseCursor._id, nextLease)
    else await ctx.db.insert('claimCursor', { key: 'leases', ...nextLease })

    const candidates = [...leases, ...queued].sort((a, b) => a._creationTime - b._creationTime)

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
      // A removed member's commands never reach a bridge host, but for the logouts and login
      // cancels that tear their accounts down. Each is settled as if it ran out of time: a send
      // never handed over fails, and one that may have gone out (claimed before, lease lapsed)
      // becomes `unknown`. Neither is sent again.
      if (!TEARDOWN.has(command.payload.type) && !(await stillMember(command.userId))) {
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
    await failLogin(ctx, command, error ?? 'invalid_command')
    await onCommandRejected(ctx, command, error ?? 'invalid_command')
    return null
  },
})

/**
 * Redeems a sign-in browser ticket (docs/architecture/signin-browser.md): what the gateway
 * needs to open the browser's websocket on the right bridge host, or null for a ticket that
 * is unknown, used, expired, or for a step that is over. A ticket works once.
 */
export const redeemSigninTicket = mutation({
  args: { secret: v.string(), ticket: v.string() },
  returns: v.union(
    v.null(),
    v.object({ loginSessionId: v.id('loginSessions'), userId: v.string(), hostId: v.string(), stepId: v.string() }),
  ),
  handler: async (ctx, { secret, ticket }) => {
    assertGateway(secret)
    if (ticket.length > 256) return null
    const tokenHash = await sha256Hex(ticket)
    const row = await ctx.db
      .query('signinTickets')
      .withIndex('by_token', (q) => q.eq('tokenHash', tokenHash))
      .unique()
    if (!row) return null
    await ctx.db.delete(row._id)
    if (row.expiresAt < Date.now()) return null
    const session = await ctx.db.get(row.loginSessionId)
    // The login moved on, or to another host, since the ticket was issued.
    if (
      !session ||
      session.userId !== row.userId ||
      session.hostId !== row.hostId ||
      !browserStepOpen(session, row.stepId)
    ) {
      return null
    }
    return { loginSessionId: row.loginSessionId, userId: row.userId, hostId: row.hostId, stepId: row.stepId }
  },
})

const RESTORE_PHASES = ['scheduled', 'queued', 'claimed', 'dispatched', 'expired'] as const
const restorePhase = v.union(...RESTORE_PHASES.map((phase) => v.literal(phase)))
/** Rows one call of `settleAfterRestore` handles; each is bounded like an expiry. */
const RESTORE_BATCH = 20

/**
 * Run once after `deploy/trioditis restore`, before the gateway starts (docs/deploy.md,
 * Restore). A backup is a moment in the past, and the server ran on after it, so a send the
 * backup holds as still on its way may have gone out since. None is sent again: each becomes
 * `unknown`, and the person decides. In order, one batch a call, until `phase` is null:
 * scheduled messages whose time has come by now become sends (and so `unknown`); queued and
 * claimed commands expire as `unknown`; accepted ones are settled as `unknown`, as if overdue;
 * and a send the backend expired as `failed` when it started (its deadline came after
 * `backupAt`, so it may have gone in the meantime) is `unknown` too. Logins, logouts and new
 * chats waiting on a command end as if it expired. Safe to run again.
 */
export const settleAfterRestore = internalMutation({
  args: {
    backupAt: v.number(),
    phase: v.optional(restorePhase),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ phase: v.union(restorePhase, v.null()), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { backupAt, phase = 'scheduled', cursor = null }) => {
    const now = Date.now()
    const next = (more: boolean, nextCursor: string | null) =>
      more
        ? { phase, cursor: nextCursor }
        : { phase: RESTORE_PHASES[RESTORE_PHASES.indexOf(phase) + 1] ?? null, cursor: null }
    if (phase === 'scheduled') {
      const page = await ctx.db.query('scheduledSends').paginate({ cursor, numItems: RESTORE_BATCH })
      for (const row of page.page) if (row.state === 'scheduled' && row.sendAt <= now) await sendScheduled(ctx, row)
      return next(!page.isDone, page.continueCursor)
    }
    if (phase === 'queued' || phase === 'claimed') {
      // Each leaves the index as it expires, so the next call starts from the front again.
      const rows = await ctx.db
        .query('outbox')
        .withIndex('by_state', (q) => q.eq('state', phase))
        .take(RESTORE_BATCH)
      for (const command of rows) await expire(ctx, command, 'unknown')
      return next(rows.length === RESTORE_BATCH, null)
    }
    if (phase === 'dispatched') {
      // A settled command has no `expiresAt`, so it leaves this range too.
      const rows = await ctx.db
        .query('outbox')
        .withIndex('by_expiry', (q) => q.eq('state', 'dispatched').gte('expiresAt', 0))
        .take(RESTORE_BATCH)
      for (const command of rows) await settle(ctx, command)
      return next(rows.length === RESTORE_BATCH, null)
    }
    const page = await ctx.db
      .query('outbox')
      .withIndex('by_expiry', (q) => q.eq('state', 'expired').gte('expiresAt', backupAt))
      .paginate({ cursor, numItems: RESTORE_BATCH })
    for (const command of page.page) {
      if (command.delivery !== 'failed' || command.lastError !== 'expired') continue
      await ctx.db.patch(command._id, { delivery: 'unknown' })
      await markCopy(ctx, command, 'unknown')
    }
    return next(!page.isDone, page.continueCursor)
  },
})

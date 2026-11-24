import { ConvexError, v } from 'convex/values'
import { BRIDGE_HOST_STALE_MS, NETWORK_INFO, networkStatus, type Network } from '@trioditis/core'
import { internal } from './_generated/api'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { requireSessionIfGiven } from './lib/session'
import { requireAdmin, requireMember } from './lib/access'
import { audit } from './lib/audit'
import { bridgedNetworks, installedNetworks, offeredNetworks, removedNetwork } from './lib/networks'
import { queueLoginCancel, queueLogout } from './lib/outbox'
import { errorCode, loginState, network } from './validators'

// The networks this server offers, how to connect each, and how each is doing for the person;
// and, for admins, installing and removing them.

/** How many accounts, or login sessions, one batch of a removal goes through. */
const REMOVE_BATCH = 100
/** How many accounts `catalog` counts per network before saying "at least". */
const MAX_COUNTED = 1000

const flow = v.object({
  id: v.string(),
  kind: v.union(v.literal('qr'), v.literal('phone'), v.literal('cookies'), v.literal('form')),
  name: v.string(),
})
const maturity = v.union(v.literal('stable'), v.literal('beta'), v.literal('experimental'))

/** The networks admins installed on this server, with their login flows, in a stable order. */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      network,
      name: v.string(),
      maturity,
      flows: v.array(flow),
      termsRisk: v.boolean(),
      reactions: v.boolean(),
      edit: v.union(v.null(), v.object({ maxAgeMs: v.union(v.null(), v.number()) })),
      delete: v.union(v.null(), v.object({ forEveryone: v.boolean(), maxAgeMs: v.union(v.null(), v.number()) })),
    }),
  ),
  handler: async (ctx) => {
    await requireMember(ctx)
    const offered = await offeredNetworks(ctx)
    return Object.values(NETWORK_INFO).filter((info) => offered.has(info.network))
  },
})

/**
 * When each network's bridge host was last heard from, the most recent of its hosts. A query's
 * answer only changes when the rows it read do, not as time passes, so a host that stops
 * heartbeating would stay "online" here for as long as the client watched. The client judges
 * liveness from this time against its own clock instead (data/bridge-liveness.ts);
 * `bridgeOnline` is only how it looked when the query ran.
 */
async function hostsLastSeen(ctx: QueryCtx) {
  const hosts = await ctx.db.query('bridgeHosts').take(100)
  const seen = new Map<string, number>()
  for (const host of hosts) seen.set(host.network, Math.max(seen.get(host.network) ?? 0, host.lastSeenAt))
  return seen
}

const isLive = (lastSeenAt: number | undefined, now: number) =>
  lastSeenAt !== undefined && now - lastSeenAt <= BRIDGE_HOST_STALE_MS

/**
 * For each installed network: whether its bridge host is online, and the person's accounts on
 * it. `status` sums it up for the status bar: `offline` when the bridge host is down or none
 * of the person's accounts is connected, `degraded` when some are, `online` when all are, and
 * `none` when the person hasn't connected that network.
 */
export const health = query({
  args: {},
  returns: v.array(
    v.object({
      network,
      bridgeOnline: v.boolean(),
      /** When its bridge host was last heard from, to judge `bridgeOnline` again as time passes. */
      bridgeLastSeenAt: v.union(v.null(), v.number()),
      accounts: v.array(
        v.object({
          networkAccountId: v.id('networkAccounts'),
          state: loginState,
          error: v.union(v.null(), errorCode),
          lastHealthyAt: v.union(v.null(), v.number()),
        }),
      ),
      status: v.union(v.literal('online'), v.literal('degraded'), v.literal('offline'), v.literal('none')),
    }),
  ),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const seen = await hostsLastSeen(ctx)
    const now = Date.now()
    const accounts = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    return [...(await offeredNetworks(ctx))].map((name) => {
      const bridgeLastSeenAt = seen.get(name) ?? null
      const bridgeOnline = isLive(seen.get(name), now)
      const mine = accounts
        .filter((account) => account.network === name && account.state !== 'LOGGED_OUT')
        .map((account) => ({
          networkAccountId: account._id,
          state: account.state,
          error: account.error ?? null,
          lastHealthyAt: account.lastHealthyAt ?? null,
        }))
      return {
        network: name,
        bridgeOnline,
        bridgeLastSeenAt,
        accounts: mine,
        status: networkStatus(mine, bridgeOnline),
      }
    })
  },
})

/** How many accounts on a network haven't been logged out, anyone's, counting up to MAX_COUNTED rows. */
async function liveAccounts(ctx: QueryCtx, name: Network) {
  const accounts = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', name))
    .take(MAX_COUNTED)
  return accounts.filter((account) => account.state !== 'LOGGED_OUT').length
}

/**
 * Every network Trioditis knows, for Admin settings → Networks: whether an admin installed it,
 * whether this server runs its bridge host (`bridged`; one it doesn't can't be installed, and
 * the operator adds it with the installer) and whether that is online, and how many accounts
 * are connected to it, everyone's together. Never whose they are.
 */
export const catalog = query({
  args: {},
  returns: v.array(
    v.object({
      network,
      name: v.string(),
      maturity,
      termsRisk: v.boolean(),
      installed: v.boolean(),
      bridged: v.boolean(),
      bridgeOnline: v.boolean(),
      bridgeLastSeenAt: v.union(v.null(), v.number()),
      accounts: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const installed = await installedNetworks(ctx)
    const bridged = bridgedNetworks()
    const seen = await hostsLastSeen(ctx)
    const now = Date.now()
    const result = []
    for (const info of Object.values(NETWORK_INFO)) {
      result.push({
        network: info.network,
        name: info.name,
        maturity: info.maturity,
        termsRisk: info.termsRisk,
        installed: installed.has(info.network),
        bridged: bridged.has(info.network),
        bridgeOnline: isLive(seen.get(info.network), now),
        bridgeLastSeenAt: seen.get(info.network) ?? null,
        accounts: await liveAccounts(ctx, info.network),
      })
    }
    return result
  },
})

async function decide(ctx: MutationCtx, name: Network, installed: boolean, by: string) {
  const row = await ctx.db
    .query('serverNetworks')
    .withIndex('by_network', (q) => q.eq('network', name))
    .unique()
  const fields = { installed, updatedAt: Date.now(), updatedBy: by }
  if (row) await ctx.db.patch(row._id, fields)
  else await ctx.db.insert('serverNetworks', { network: name, ...fields })
}

/** Installs a network, so members can connect it. Only one whose bridge host this server runs. */
export const install = mutation({
  args: { network, sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    if (!bridgedNetworks().has(args.network)) {
      throw new ConvexError(
        `This server doesn’t run a bridge for ${NETWORK_INFO[args.network].name}, so it can’t be installed here.`,
      )
    }
    if ((await installedNetworks(ctx)).has(args.network)) return null
    await decide(ctx, args.network, true, admin.userId)
    await audit(ctx, { kind: 'user', id: admin.userId }, 'networks.install', args.network)
    return null
  },
})

/**
 * Removes a network: nobody can connect it any more, and every account on it, anyone's, is
 * logged out of it, as if its owner had disconnected it. Their chats stay. Logins still in
 * progress on it end. The logouts go out in batches (`disconnect`), after this returns; an
 * account whose login finishes anyway is logged out when it reports in (lib/ingest.ts).
 */
export const remove = mutation({
  args: { network, sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    await decide(ctx, args.network, false, admin.userId)
    await ctx.scheduler.runAfter(0, internal.networks.disconnect, { network: args.network })
    await audit(ctx, { kind: 'user', id: admin.userId }, 'networks.remove', args.network)
    return null
  },
})

/**
 * One batch of a removal: ends the logins in progress on the network, then logs out its
 * accounts a page at a time, carrying on until it has been through them all. It stops if an
 * admin installs the network again meanwhile.
 */
export const disconnect = internalMutation({
  args: { network, cursor: v.optional(v.union(v.null(), v.string())) },
  returns: v.null(),
  handler: async (ctx, { network: name, cursor }) => {
    if (!(await removedNetwork(ctx, name))) return null
    if (cursor === undefined) {
      // Ended here, not only when the bridge host confirms the cancel, so a step it sends
      // meanwhile can't bring one back. Each batch leaves these states, so the next finds the rest.
      let ended = 0
      for (const state of ['pending', 'active'] as const) {
        const sessions = await ctx.db
          .query('loginSessions')
          .withIndex('by_network_state', (q) => q.eq('network', name).eq('state', state))
          .take(REMOVE_BATCH - ended)
        for (const session of sessions) {
          await queueLoginCancel(ctx, session)
          await ctx.db.patch(session._id, { state: 'cancelled', updatedAt: Date.now() })
        }
        ended += sessions.length
      }
      await ctx.scheduler.runAfter(0, internal.networks.disconnect, {
        network: name,
        ...(ended === REMOVE_BATCH ? {} : { cursor: null }),
      })
      return null
    }
    const page = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', name))
      .paginate({ numItems: REMOVE_BATCH, cursor })
    for (const account of page.page) await queueLogout(ctx, account)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.networks.disconnect, { network: name, cursor: page.continueCursor })
    }
    return null
  },
})

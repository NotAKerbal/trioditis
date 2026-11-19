import { ConvexError, v } from 'convex/values'
import { NETWORK_INFO, type Network } from '@trioditis/core'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireAdmin, requireMember } from './lib/access'
import { audit } from './lib/audit'
import { bridgedNetworks, installedNetworks, offeredNetworks } from './lib/networks'
import { queueLoginCancel, queueLogout } from './logins'
import { errorCode, loginState, network } from './validators'

// The networks this server offers, how to connect each, and how each is doing for the person;
// and, for admins, installing and removing them.

/** A bridge host heard from within this long is online; it heartbeats every 30 seconds. */
const HOST_STALE_MS = 2 * 60_000
/** The most accounts, and login sessions, one removal goes through. */
const MAX_REMOVED = 1000

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
    }),
  ),
  handler: async (ctx) => {
    await requireMember(ctx)
    const offered = await offeredNetworks(ctx)
    return Object.values(NETWORK_INFO).filter((info) => offered.has(info.network))
  },
})

async function onlineHosts(ctx: QueryCtx) {
  const now = Date.now()
  const hosts = await ctx.db.query('bridgeHosts').take(100)
  return new Set(hosts.filter((host) => now - host.lastSeenAt <= HOST_STALE_MS).map((host) => host.network))
}

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
    const online = await onlineHosts(ctx)
    const accounts = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    return [...(await offeredNetworks(ctx))].map((name) => {
      const bridgeOnline = online.has(name)
      const mine = accounts
        .filter((account) => account.network === name && account.state !== 'LOGGED_OUT')
        .map((account) => ({
          networkAccountId: account._id,
          state: account.state,
          error: account.error ?? null,
          lastHealthyAt: account.lastHealthyAt ?? null,
        }))
      const connected = mine.filter((account) => account.state === 'CONNECTED').length
      const status: 'online' | 'degraded' | 'offline' | 'none' =
        mine.length === 0
          ? 'none'
          : !bridgeOnline || connected === 0
            ? 'offline'
            : connected < mine.length
              ? 'degraded'
              : 'online'
      return { network: name, bridgeOnline, accounts: mine, status }
    })
  },
})

/** Every account on a network that hasn't been logged out, anyone's, up to MAX_REMOVED. */
async function liveAccounts(ctx: QueryCtx, name: Network) {
  const accounts = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', name))
    .take(MAX_REMOVED)
  return accounts.filter((account) => account.state !== 'LOGGED_OUT')
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
      accounts: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const installed = await installedNetworks(ctx)
    const bridged = bridgedNetworks()
    const online = await onlineHosts(ctx)
    const result = []
    for (const info of Object.values(NETWORK_INFO)) {
      result.push({
        network: info.network,
        name: info.name,
        maturity: info.maturity,
        termsRisk: info.termsRisk,
        installed: installed.has(info.network),
        bridged: bridged.has(info.network),
        bridgeOnline: online.has(info.network),
        accounts: (await liveAccounts(ctx, info.network)).length,
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
 * progress on it are stopped. Returns how many accounts are being disconnected.
 */
export const remove = mutation({
  args: { network, sessionId: v.optional(v.string()) },
  returns: v.object({ disconnecting: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    await decide(ctx, args.network, false, admin.userId)
    let disconnecting = 0
    for (const account of await liveAccounts(ctx, args.network)) {
      if (await queueLogout(ctx, account)) disconnecting++
    }
    // Sessions have no index by network; there are few, and old ones are settled.
    const sessions = await ctx.db.query('loginSessions').order('desc').take(MAX_REMOVED)
    for (const session of sessions) {
      if (session.network === args.network && (session.state === 'pending' || session.state === 'active')) {
        await queueLoginCancel(ctx, session)
      }
    }
    await audit(ctx, { kind: 'user', id: admin.userId }, 'networks.remove', args.network)
    return { disconnecting }
  },
})

import { v } from 'convex/values'
import { NETWORK_INFO } from '@trioditis/core'
import { query } from './_generated/server'
import { requireMember } from './lib/access'
import { enabledNetworks } from './lib/networks'
import { errorCode, loginState, network } from './validators'

// The networks this server offers, how to connect each, and how each is doing for the person.

/** A bridge host heard from within this long is online; it heartbeats every 30 seconds. */
const HOST_STALE_MS = 2 * 60_000

const flow = v.object({
  id: v.string(),
  kind: v.union(v.literal('qr'), v.literal('phone'), v.literal('cookies'), v.literal('form')),
  name: v.string(),
})

/** The networks the admin enabled on this server, with their login flows, in a stable order. */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      network,
      name: v.string(),
      maturity: v.union(v.literal('stable'), v.literal('beta'), v.literal('experimental')),
      flows: v.array(flow),
      termsRisk: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await requireMember(ctx)
    const enabled = enabledNetworks()
    return Object.values(NETWORK_INFO).filter((info) => enabled.has(info.network))
  },
})

/**
 * For each enabled network: whether its bridge host is online, and the person's accounts on
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
    const now = Date.now()
    const hosts = await ctx.db.query('bridgeHosts').take(100)
    const accounts = await ctx.db
      .query('networkAccounts')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(100)
    return [...enabledNetworks()].map((name) => {
      const bridgeOnline = hosts.some((host) => host.network === name && now - host.lastSeenAt <= HOST_STALE_MS)
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

import { v } from 'convex/values'
import { BRIDGE_HOST_STALE_MS } from '@trioditis/core'
import { internal } from './_generated/api'
import { internalAction, internalMutation, internalQuery, query } from './_generated/server'
import { requireAdmin } from './lib/access'
import { network } from './validators'

// Whether the server is keeping up, for Admin settings → Server health: how quickly it answers
// a small query of its own, and how each bridge host's deliveries are going. Times and counts
// only, never anything a message or a chat says.

/** The probes kept: an hour's, at one a minute. */
const PROBES_KEPT = 60
/** Tries at keeping a probe's answer, this far apart: all within the minute before the next. */
const RECORD_TRIES = 5
const RECORD_WAIT_MS = 8_000

/** A small query, timed by `probe`: one read, as the lightest of the app's own queries make. */
export const ping = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.query('serverProbes').first()
    return null
  },
})

/**
 * Times the server answering `ping`, once a minute (crons.ts). On a server short of CPU every
 * function waits its turn, so this slows, and times out, along with the queries people's pages
 * make. An action's clock moves as it runs, where a query's or a mutation's doesn't.
 */
export const probe = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const at = Date.now()
    let ok = true
    try {
      await ctx.runQuery(internal.health.ping, {})
    } catch {
      ok = false
    }
    const sample = { at, ms: Date.now() - at, ok }
    // On a starved server the write times out too, and a lost failure would read as a quiet
    // hour: it's tried again, within the minute, until it's kept.
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.runMutation(internal.health.record, sample)
        return null
      } catch (error) {
        if (attempt >= RECORD_TRIES - 1) throw error
        await new Promise((resolve) => setTimeout(resolve, RECORD_WAIT_MS))
      }
    }
  },
})

export const record = internalMutation({
  args: { at: v.number(), ms: v.number(), ok: v.boolean() },
  returns: v.null(),
  handler: async (ctx, sample) => {
    const row = await ctx.db.query('serverProbes').first()
    if (!row) {
      await ctx.db.insert('serverProbes', { samples: [sample] })
      return null
    }
    await ctx.db.patch(row._id, { samples: [...row.samples, sample].slice(-PROBES_KEPT) })
    return null
  },
})

export const server = query({
  args: {},
  returns: v.object({
    probes: v.array(v.object({ at: v.number(), ms: v.number(), ok: v.boolean() })),
    bridges: v.array(
      v.object({
        network,
        /** Whether the host has been heard from lately; its counts are as it last said otherwise. */
        live: v.boolean(),
        backlog: v.number(),
        pushMs: v.number(),
        failedPushes: v.number(),
        at: v.number(),
      }),
    ),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const probes = (await ctx.db.query('serverProbes').first())?.samples ?? []
    const now = Date.now()
    const hosts = await ctx.db.query('bridgeHosts').take(100)
    const pressure = await ctx.db.query('bridgePressure').take(100)
    const bridges = pressure.flatMap((p) => {
      const host = hosts.find((h) => h.hostId === p.hostId)
      // A network that was removed keeps its old rows; only the ones it can still name show.
      if (!host || (p.network as string) === 'fake') return []
      return [
        {
          network: p.network,
          live: now - host.lastSeenAt <= BRIDGE_HOST_STALE_MS,
          backlog: p.backlog,
          pushMs: p.pushMs,
          failedPushes: p.failedPushes,
          at: p.at,
        },
      ]
    })
    return { probes, bridges }
  },
})

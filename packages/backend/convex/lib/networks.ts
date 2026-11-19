import { NETWORKS, type Network } from '@trioditis/core'
import type { QueryCtx } from '../_generated/server'

/**
 * The networks this server runs a bridge host for: TRIODITIS_NETWORKS, a comma-separated list
 * the installer (or `pnpm dev`) sets. These are the ones an admin can install; a backend that
 * says none, such as a demo on Convex's cloud, has no bridge host at all.
 */
export function bridgedNetworks(): Set<Network> {
  const configured = process.env.TRIODITIS_NETWORKS ?? ''
  const known = new Set<string>(NETWORKS)
  return new Set(
    configured
      .split(',')
      .map((name) => name.trim())
      .filter((name): name is Network => known.has(name)),
  )
}

/** The networks admins have installed (`serverNetworks`), whether or not a bridge host runs them. */
export async function installedNetworks(ctx: QueryCtx): Promise<Set<Network>> {
  const rows = await ctx.db.query('serverNetworks').take(NETWORKS.length)
  return new Set(rows.filter((row) => row.installed).map((row) => row.network))
}

/** The networks people can connect: installed by an admin, with a bridge host to run them. */
export async function offeredNetworks(ctx: QueryCtx): Promise<Set<Network>> {
  const bridged = bridgedNetworks()
  return new Set([...(await installedNetworks(ctx))].filter((name) => bridged.has(name)))
}

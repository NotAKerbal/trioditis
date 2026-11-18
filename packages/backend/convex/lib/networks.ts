import type { Network } from '@trioditis/core'

/**
 * The networks this server offers, as the admin chose them: TRIODITIS_NETWORKS, a comma-
 * separated list. The admin panel will manage this; until then it is set at install.
 */
export function enabledNetworks(): Set<Network> {
  const configured = process.env.TRIODITIS_NETWORKS ?? 'whatsapp'
  return new Set(
    configured
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean) as Network[],
  )
}

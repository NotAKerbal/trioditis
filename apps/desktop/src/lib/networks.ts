import type { Maturity, Network } from '@trioditis/core'

// What the app shows for each network. The maturity labels follow docs/PLAN.md, Networks.
export const NETWORK_INFO: Record<Network, { name: string; maturity: Maturity }> = {
  whatsapp: { name: 'WhatsApp', maturity: 'stable' },
  signal: { name: 'Signal', maturity: 'stable' },
  gmessages: { name: 'Google Messages', maturity: 'stable' },
  telegram: { name: 'Telegram', maturity: 'beta' },
  meta: { name: 'Messenger', maturity: 'beta' },
  instagram: { name: 'Instagram', maturity: 'beta' },
  discord: { name: 'Discord', maturity: 'experimental' },
  fake: { name: 'Test network', maturity: 'experimental' },
}

export const networkName = (network: string) => NETWORK_INFO[network as Network]?.name ?? network

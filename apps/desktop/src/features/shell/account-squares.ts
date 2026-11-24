import type { LoginState } from '@trioditis/core/bridge-protocol'

interface HealthRow {
  bridgeOnline: boolean
  accounts: readonly { networkAccountId: string; state: LoginState }[]
}

/**
 * As many squares as fit in the status bar, 8 columns of 2, with room left beside them for the
 * trouble count, Settings and the start of the person's name, on a phone as in the sidebar.
 */
export const MAX_SQUARES = 16

/**
 * One square for each of the person's accounts in the status bar, in network order so a
 * network's accounts sit together. An account is up when it's connected and its network's
 * bridge host is, since a connected login on a host that's gone can't send or receive.
 *
 * Past `max`, connected accounts give way first, so those that need attention are shown before
 * any that don't (all of them, unless there are more than `max`).
 */
export function accountSquares(health: readonly HealthRow[], max = MAX_SQUARES): { id: string; online: boolean }[] {
  const all = health.flatMap((h) =>
    h.accounts.map((a) => ({ id: a.networkAccountId, online: h.bridgeOnline && a.state === 'CONNECTED' })),
  )
  if (all.length <= max) return all
  let onlineRoom = Math.max(0, max - all.filter((s) => !s.online).length)
  let room = max
  return all.filter((s) => {
    if (room === 0) return false
    if (s.online && onlineRoom-- <= 0) return false
    room--
    return true
  })
}

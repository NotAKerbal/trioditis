import type { ErrorCode, LoginState } from '@trioditis/core/bridge-protocol'
import { errorMessage } from '~/lib/errors.ts'

// How Settings → Accounts shows each account: which group it's in, what's said under it, and
// what can be done with it. Grouped by what is really so, so a logged-out account isn't listed
// as connected, and only actions that do something are offered.

export type AccountGroup = 'connected' | 'attention' | 'loggedOut'

export const GROUP_TITLES: Record<AccountGroup, string> = {
  connected: 'Connected',
  attention: 'Needs attention',
  loggedOut: 'Logged out',
}

export interface AccountRow {
  state: LoginState
  logoutPending: boolean
  logoutError: ErrorCode | null
}

export interface AccountView {
  group: AccountGroup
  /** The line under the account, or null when there's nothing to add to its group. */
  note: string | null
  warn: boolean
  /** Connecting it again: offered where the network signed it out or it's logged out. */
  reconnect: boolean
  /** Logging it out: offered while it's still logged in anywhere, and not while one is on its way. */
  disconnect: boolean
}

// Why a disconnect didn't finish (`logoutError`). `expired`: no bridge host took it within 10
// minutes; `timeout`: one took it but never confirmed. Either way it may still be connected.
const LOGOUT_ERROR: Partial<Record<ErrorCode, string>> = {
  expired: 'The server’s bridge didn’t pick up the disconnect, so it’s still connected. Try again.',
  timeout: 'The server’s bridge never confirmed the disconnect, so it may still be connected. Try again.',
  not_connected:
    'The server’s bridge couldn’t reach the network to disconnect it, so it may still be connected. Try again.',
  network_rejected: 'The network refused the disconnect, so it’s still connected. Try again.',
  rate_limited: 'The network is limiting requests, so it’s still connected. Wait a few minutes, then try again.',
}

const STATE_NOTE: Record<LoginState, string | null> = {
  CONNECTED: null,
  CONNECTING: 'Connecting…',
  TRANSIENT_DISCONNECT: 'Lost the connection to the network. Reconnecting by itself…',
  BAD_CREDENTIALS: 'The network signed this account out. Reconnect it.',
  UNKNOWN_ERROR: 'Something went wrong with this account. Reconnect it, or disconnect it.',
  LOGGED_OUT: null,
}

export function accountView(account: AccountRow, bridgeDown: boolean): AccountView {
  const { state, logoutPending, logoutError } = account
  if (state === 'LOGGED_OUT') {
    return { group: 'loggedOut', note: null, warn: false, reconnect: true, disconnect: false }
  }
  const signedOut = state === 'BAD_CREDENTIALS' || state === 'UNKNOWN_ERROR'
  const live = state === 'CONNECTED' || state === 'CONNECTING'
  if (logoutPending) {
    // It stays where it is until the bridge host confirms the logout.
    const group = live && !bridgeDown ? 'connected' : 'attention'
    return { group, note: 'Disconnecting…', warn: false, reconnect: false, disconnect: false }
  }
  if (logoutError) {
    return {
      group: 'attention',
      note: LOGOUT_ERROR[logoutError] ?? 'It couldn’t be disconnected, so it may still be connected. Try again.',
      warn: true,
      reconnect: signedOut,
      disconnect: true,
    }
  }
  if (bridgeDown) {
    // Its own state is what the bridge host said last, before it stopped answering.
    return {
      group: 'attention',
      note: 'The server’s bridge for this network isn’t responding, so nothing new arrives.',
      warn: true,
      reconnect: false,
      disconnect: true,
    }
  }
  if (live) {
    return { group: 'connected', note: STATE_NOTE[state], warn: false, reconnect: false, disconnect: true }
  }
  return { group: 'attention', note: STATE_NOTE[state], warn: true, reconnect: signedOut, disconnect: true }
}

/** What to say when asking to disconnect `label` failed, without the raw error. */
export function disconnectFailure(error: unknown, label: string): string {
  const fallback = `${label} couldn’t be disconnected, so it’s still connected. Check your connection, then try again.`
  // Only a sentence the server wrote for the person; anything else (a dropped connection, a
  // server error) gets the fallback rather than its technical message.
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined
  if (data === undefined) return fallback
  const message = errorMessage(error, fallback)
  return message === 'That account doesn’t exist.' ? `${label} isn’t one of your accounts any more.` : message
}

/** What to tell the person once a disconnect was asked for (logins.logout's answer). */
export function disconnectResult(result: 'queued' | 'pending' | 'loggedOut', label: string): string {
  if (result === 'pending') return `${label} is already disconnecting.`
  if (result === 'loggedOut') return `${label} is already logged out.`
  return `Disconnecting ${label}…`
}

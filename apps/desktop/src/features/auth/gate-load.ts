/**
 * What the key gate shows before it can decide between setup, unlock and the app:
 *
 * - `wait`: the splash, while this device's own storage is read (quick, local) or the server is
 *   still being asked and nothing here can stand in for its answer.
 * - `decide`: the server has said what the account's key state is.
 * - `openLocal`: the server hasn't answered (still connecting, offline, or failed), but this device
 *   already keeps the person's key. An account's identity key never changes once set (keys.setup
 *   refuses another), and a key is kept here only once its backups exist, so the app can open with
 *   it rather than wait. Not while a recovery key shown before a reload is still to be checked: that
 *   check needs the server.
 * - `failed`: the server's answer failed and there's no key here to go on with: say so, with retry.
 */
export type KeyGateLoad = 'wait' | 'decide' | 'openLocal' | 'failed'

export function keyGateLoad(state: {
  /** The save token: null until it has been read from this device's storage. */
  token: number | 'failed' | null
  remote: { failed: boolean; hasData: boolean }
  local: { pending: boolean; hasKey: boolean }
  /** A recovery key shown before a reload still waits to be checked against the server. */
  recoveryCheckPending: boolean
}): KeyGateLoad {
  if (state.token === null || state.local.pending) return 'wait'
  if (state.remote.hasData) return 'decide'
  if (state.local.hasKey && !state.recoveryCheckPending) return 'openLocal'
  return state.remote.failed ? 'failed' : 'wait'
}

/** How long the splash waits on the server before it also says it's still trying. */
export const SLOW_SERVER_MS = 15_000

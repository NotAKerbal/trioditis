// Sends and login details are sealed to the bridge key, so until there's one nothing can be
// sent: the composer and a login step that needs input stay disabled, saying why. While the key
// loads nothing is disabled for it; if it can't be looked up, that's said apart from the server
// having none (`keys.bridge` null).

export type BridgeStatus = 'loading' | 'ready' | 'missing' | 'error'

export const NO_BRIDGE_SEND = 'Sending isn’t set up on this server yet'
export const NO_BRIDGE_LOGIN =
  'This server can’t take login details yet: its bridge isn’t set up. Ask the server’s admin.'
export const BRIDGE_LOOKUP_FAILED = 'Couldn’t check whether this server can send. Check your connection.'

/** Why the composer can't send in this chat, or null when it can. */
export function composerBlocked(row: { blocked: boolean; isRequest: boolean }, bridge: BridgeStatus): string | null {
  if (row.blocked) return 'You blocked this chat'
  if (row.isRequest) return 'Accept the request to reply'
  if (bridge === 'missing') return NO_BRIDGE_SEND
  if (bridge === 'error') return BRIDGE_LOOKUP_FAILED
  return null
}

/** Why a login step's input can't be sent, or null when it can (or soon will, once it loads). */
export function loginInputBlocked(bridge: BridgeStatus): string | null {
  if (bridge === 'missing') return NO_BRIDGE_LOGIN
  if (bridge === 'error') return BRIDGE_LOOKUP_FAILED
  return null
}

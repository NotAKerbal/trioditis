// Sends and login details are sealed to the bridge key, so without one (`keys.bridge` is null)
// nothing can be sent: the composer and a login step that needs input stay disabled, saying why.
// While the key is still loading (undefined), nothing is disabled for it.

export const NO_BRIDGE_SEND = 'Sending isn’t set up on this server yet'
export const NO_BRIDGE_LOGIN =
  'This server can’t take login details yet: its bridge isn’t set up. Ask the server’s admin.'

/** Why the composer can't send in this chat, or null when it can. */
export function composerBlocked(
  row: { blocked: boolean; isRequest: boolean },
  bridgeKey: string | null | undefined,
): string | null {
  if (row.blocked) return 'You blocked this chat'
  if (row.isRequest) return 'Accept the request to reply'
  if (bridgeKey === null) return NO_BRIDGE_SEND
  return null
}

/** Why a login step's input can't be sent, or null when it can. */
export function loginInputBlocked(bridgeKey: string | null | undefined): string | null {
  return bridgeKey === null ? NO_BRIDGE_LOGIN : null
}

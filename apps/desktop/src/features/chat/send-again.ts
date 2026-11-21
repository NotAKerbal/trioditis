import { useSyncExternalStore } from 'react'

// Sending a failed or unconfirmed message again, once. The replacement's client message ID is
// worked out from the original's, so every click, in any tab or after a reload, asks for the
// same send, and the server does nothing with an ID it has seen (client-api.md, Sending). While
// one is on its way the button is off, and once it has gone the original offers only Discard.
// Nothing here runs on its own: a send whose outcome is `unknown` goes again only on a click.

const SUFFIX = /-a(\d+)$/
const MAX_ID = 64

/**
 * The client message ID of `clientMessageId`'s one replacement: `-a1` added, or the number of
 * a replacement's own replacement counted up, so a chain of them stays short. Within the
 * server's 16 to 64 characters of letters, digits, `-` and `_`.
 */
export function replacementId(clientMessageId: string): string {
  const match = SUFFIX.exec(clientMessageId)
  const base = match ? clientMessageId.slice(0, match.index) : clientMessageId
  const next = `-a${match ? Number(match[1]) + 1 : 1}`
  return base.slice(0, MAX_ID - next.length) + next
}

export type SendAgainState = 'sending' | 'sent'

let states = new Map<string, SendAgainState>()
const listeners = new Set<() => void>()

function set(clientMessageId: string, state: SendAgainState | undefined) {
  states = new Map(states)
  if (state) states.set(clientMessageId, state)
  else states.delete(clientMessageId)
  for (const listener of listeners) listener()
}

/**
 * Sends `clientMessageId`'s replacement with `send`, given its ID, unless one is on its way or
 * has gone already from this page. If it fails, it can be tried again: with the same ID, so a
 * send that did reach the server isn't made twice.
 */
export async function sendAgain(clientMessageId: string, send: (replacement: string) => Promise<void>) {
  if (states.has(clientMessageId)) return
  set(clientMessageId, 'sending')
  try {
    await send(replacementId(clientMessageId))
    set(clientMessageId, 'sent')
  } catch {
    set(clientMessageId, undefined)
  }
}

/** Where a message's replacement stands: on its way, gone, or not asked for. */
export function againState(
  clientMessageId: string | undefined,
  local: ReadonlyMap<string, SendAgainState>,
  loadedIds: ReadonlySet<string>,
): SendAgainState | undefined {
  if (!clientMessageId) return undefined
  // Its replacement in the list means it went, from this page or another.
  if (loadedIds.has(replacementId(clientMessageId))) return 'sent'
  return local.get(clientMessageId)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSendAgainStates = () => useSyncExternalStore(subscribe, () => states)

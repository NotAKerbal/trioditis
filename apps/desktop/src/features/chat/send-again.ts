import { digest } from '@trioditis/crypto'
import { useSyncExternalStore } from 'react'

// Sending a failed or unconfirmed message again, once. The replacement's client message ID is
// worked out from the original's, so every click, in any tab or after a reload, asks for the
// same send, and the server does nothing with an ID it has seen (client-api.md, Sending). While
// one is on its way the button is off, and once it has gone the original offers only Discard.
// Nothing here runs on its own: a send whose outcome is `unknown` goes again only on a click.

/**
 * The client message ID of `clientMessageId`'s one replacement: a hash of it, under a prefix
 * of its own, 46 characters within the server's 16 to 64. A hash, not a suffix, so it can't be
 * the ID of some other send, and a replacement's own replacement is as short.
 */
export function replacementId(clientMessageId: string): string {
  return `ra_${digest(`trioditis/send-again/v1/${clientMessageId}`)}`
}

/**
 * Where a message's replacement stands: on its way; gone; or `used`, when the server said its
 * ID had gone already (from another tab, or before a reload), so nothing went this time.
 */
export type SendAgainState = 'sending' | 'sent' | 'used'

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
 * send that did reach the server isn't made twice. `send` answers as messages.send does:
 * `queued` for a new send, or what the ID had gone as already.
 */
export async function sendAgain(
  clientMessageId: string,
  send: (replacement: string) => Promise<'queued' | 'sent' | 'scheduled'>,
): Promise<SendAgainState | undefined> {
  if (states.has(clientMessageId)) return states.get(clientMessageId)
  set(clientMessageId, 'sending')
  const replacement = replacementId(clientMessageId)
  let outcome: 'queued' | 'sent' | 'scheduled'
  try {
    outcome = await send(replacement)
  } catch {
    set(clientMessageId, undefined)
    return undefined
  }
  const state = outcome === 'queued' ? 'sent' : 'used'
  set(clientMessageId, state)
  return state
}

/** Where a message's replacement stands, from this page or, by its copy in the list, any other. */
export function againState(
  clientMessageId: string | undefined,
  local: ReadonlyMap<string, SendAgainState>,
  loadedIds: ReadonlySet<string>,
): SendAgainState | undefined {
  if (!clientMessageId) return undefined
  if (loadedIds.has(replacementId(clientMessageId))) return 'sent'
  return local.get(clientMessageId)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSendAgainStates = () => useSyncExternalStore(subscribe, () => states)

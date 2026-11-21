import { digest } from '@trioditis/crypto'
import { useSyncExternalStore } from 'react'

// Sending a failed or unconfirmed message again. Each attempt is a link in a chain: the first
// replacement's client message ID is worked out from the original's, and each next one from the
// one before, only once that one has failed. So every click, in any tab or after a reload, asks
// for the same send as the others for that link, and the server does nothing with an ID it has
// seen (client-api.md, Sending). Where the chain stands is read from the messages themselves
// (their delivery states) and from the server's answers here, never guessed. Nothing here runs
// on its own: a send whose outcome is `unknown` goes again only on a click.

/**
 * The client message ID of the next attempt after `clientMessageId`: a hash of it, under a
 * prefix of its own, 46 characters within the server's 16 to 64. A hash, not a suffix, so it
 * can't be the ID of some other send, and every link in the chain is as short.
 */
export function replacementId(clientMessageId: string): string {
  return `ra_${digest(`trioditis/send-again/v1/${clientMessageId}`)}`
}

/**
 * Where an attempt stands: on its way from here (`sending`); taken and being sent (`going`);
 * sent (`sent`); may have been sent (`maybe`); or failed (`failed`), when another can be made.
 */
export type SendAgainState = 'sending' | 'going' | 'sent' | 'maybe' | 'failed'

/** The answer messages.send gives: new, or what the ID went as already. */
export type SendAnswer =
  'queued' | { already: 'send'; delivery: string | null } | { already: 'scheduled'; state: string }

/** Where a message is, by its delivery state. */
export function fromDelivery(delivery: string | null | undefined): Exclude<SendAgainState, 'sending'> {
  switch (delivery) {
    case undefined:
    case 'queued':
    case 'claimed':
    case 'submitted':
      return 'going'
    case 'sent':
    case 'delivered':
    case 'read':
      return 'sent'
    case 'failed':
      return 'failed'
    default:
      return 'maybe'
  }
}

/** Where an attempt stands by the server's answer: a new send is on its way, not sent yet. */
export function stateOf(answer: SendAnswer): Exclude<SendAgainState, 'sending'> {
  if (answer === 'queued') return 'going'
  if (answer.already === 'scheduled') return answer.state === 'scheduled' ? 'going' : 'failed'
  return fromDelivery(answer.delivery)
}

/**
 * The chain's latest attempt for `original`: each link known from this page's answers (`local`)
 * or from its copy in the list (`listed`, client message ID to delivery state), going on past
 * failed ones only. Null when none has been made.
 */
export function latestAttempt(
  original: string,
  local: ReadonlyMap<string, SendAgainState>,
  listed: ReadonlyMap<string, string | null | undefined>,
): { id: string; state: SendAgainState } | null {
  let latest: { id: string; state: SendAgainState } | null = null
  let id = original
  for (let i = 0; i < 50; i++) {
    const next = replacementId(id)
    // The list shows how it really stands; this page's answer is for one not loaded (or gone).
    const state = listed.has(next) ? fromDelivery(listed.get(next)) : local.get(next)
    if (!state) break
    latest = { id: next, state }
    if (state !== 'failed') break
    id = next
  }
  return latest
}

let states = new Map<string, SendAgainState>()
const listeners = new Set<() => void>()

function set(id: string, state: SendAgainState | undefined) {
  states = new Map(states)
  if (state) states.set(id, state)
  else states.delete(id)
  for (const listener of listeners) listener()
}

/**
 * Makes the next attempt for `original` with `send`, given its ID: the first replacement, or
 * the one after the latest if that one failed. Nothing if the latest is on its way, sent, or may
 * have been. If the call doesn't reach the server, the same link can be tried again with the
 * same ID, so one that did reach it isn't made twice.
 */
export async function sendAgain(
  original: string,
  listed: ReadonlyMap<string, string | null | undefined>,
  send: (id: string) => Promise<SendAnswer>,
): Promise<SendAgainState | undefined> {
  const latest = latestAttempt(original, states, listed)
  if (latest && latest.state !== 'failed') return latest.state
  const id = replacementId(latest?.id ?? original)
  if (states.get(id) === 'sending') return 'sending'
  set(id, 'sending')
  try {
    const state = stateOf(await send(id))
    set(id, state)
    return state
  } catch {
    set(id, undefined)
    return undefined
  }
}

/** Where a message's chain of attempts stands, from this page and the list. */
export function againState(
  original: string | undefined,
  local: ReadonlyMap<string, SendAgainState>,
  listed: ReadonlyMap<string, string | null | undefined>,
): SendAgainState | undefined {
  return original ? latestAttempt(original, local, listed)?.state : undefined
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSendAgainStates = () => useSyncExternalStore(subscribe, () => states)

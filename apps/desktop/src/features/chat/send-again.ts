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
 * Where a message's replacement stands: on its way from here (`sending`); sent (`sent`); or,
 * when the server said its ID was used already (from another tab, or before a reload), how
 * that send stands: still going (`going`), may have gone (`maybe`), or failed (`failed`), when
 * it can be sent once more as a new message.
 */
export type SendAgainState = 'sending' | 'sent' | 'going' | 'maybe' | 'failed'

/** The answer messages.send gives: new, or what the ID went as already. */
export type SendAnswer =
  'queued' | { already: 'send'; delivery: string | null } | { already: 'scheduled'; state: string }

/** Where a replacement stands by the server's answer. */
export function stateOf(answer: SendAnswer): SendAgainState {
  if (answer === 'queued') return 'sent'
  if (answer.already === 'scheduled') return answer.state === 'scheduled' ? 'going' : 'failed'
  switch (answer.delivery) {
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
 * has gone already from this page. If it fails to reach the server, it can be tried again with
 * the same ID, so a send that did reach it isn't made twice. Once the server says the
 * replacement failed, `asNew` sends it again under a new ID: the person chose a new message.
 */
export async function sendAgain(
  clientMessageId: string,
  send: (replacement: string) => Promise<SendAnswer>,
  { asNew = false }: { asNew?: boolean } = {},
): Promise<SendAgainState | undefined> {
  const now = states.get(clientMessageId)
  if (now && !(asNew && now === 'failed')) return now
  set(clientMessageId, 'sending')
  const replacement = asNew ? `rn_${crypto.randomUUID().replaceAll('-', '')}` : replacementId(clientMessageId)
  let answer: SendAnswer
  try {
    answer = await send(replacement)
  } catch {
    set(clientMessageId, now)
    return now
  }
  const state = stateOf(answer)
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

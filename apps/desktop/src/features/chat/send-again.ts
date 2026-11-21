import { digest } from '@trioditis/crypto'
import { useSyncExternalStore } from 'react'

// Sending a failed or unconfirmed message again. Each attempt is a link in a chain from the
// original: the first attempt's client message ID is worked out from the original's, and each
// next one from the one before, only once that one has failed. So every click, from any row of
// the chain, in any tab or after a reload, asks for the same send as the others for that link,
// and the server does nothing with an ID it has seen (client-api.md, Sending). Where the chain
// stands is read from how its links stand: their copies in the list, or the server
// (messages.sendStates) for one whose copy is gone. Nothing here runs on its own: a send whose
// outcome is `unknown` goes again only on a click, and only while no later attempt might have
// gone.

/** The most attempts a message can have; enough for any person, and what's asked of the server. */
export const MAX_ATTEMPTS = 8

const ids = new Map<string, string>()

/**
 * The client message ID of the next attempt after `clientMessageId`: a hash of it, under a
 * prefix of its own, 46 characters within the server's 16 to 64. A hash, not a suffix, so it
 * can't be the ID of some other send, and every link in the chain is as short.
 */
export function replacementId(clientMessageId: string): string {
  let id = ids.get(clientMessageId)
  if (!id) {
    id = `ra_${digest(`trioditis/send-again/v1/${clientMessageId}`)}`
    if (ids.size > 5000) ids.clear()
    ids.set(clientMessageId, id)
  }
  return id
}

/** The IDs every attempt for `original` would have, in order. */
export function chainOf(original: string): string[] {
  const out: string[] = []
  let id = original
  for (let i = 0; i < MAX_ATTEMPTS; i++) out.push((id = replacementId(id)))
  return out
}

/**
 * Where a chain stands, by its latest attempt: on its way from here (`sending`); taken and
 * being sent (`going`); sent (`sent`); may have been sent (`maybe`); or failed (`failed`), when
 * another attempt can be made.
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
 * The latest attempt for `original`, from how its links stand (`known`: client message ID to
 * state, from the list and the server) and which are on their way from this page, going on
 * past failed ones only. Null when none has been made.
 */
export function latestAttempt(
  original: string,
  known: ReadonlyMap<string, SendAgainState>,
  sending: ReadonlySet<string>,
): { id: string; state: SendAgainState } | null {
  let latest: { id: string; state: SendAgainState } | null = null
  for (const id of chainOf(original)) {
    const state = sending.has(id) ? 'sending' : known.get(id)
    if (!state) break
    latest = { id, state }
    if (state !== 'failed') break
  }
  return latest
}

/** The next attempt's ID, if one may be made now: none yet, or the latest failed. */
export function nextAttempt(
  original: string,
  known: ReadonlyMap<string, SendAgainState>,
  sending: ReadonlySet<string>,
): string | null {
  const latest = latestAttempt(original, known, sending)
  if (latest && latest.state !== 'failed') return null
  const chain = chainOf(original)
  const next = latest ? chain[chain.indexOf(latest.id) + 1] : chain[0]
  return next ?? null
}

/**
 * Each row's chain: the original it belongs to, for every message that is one of a chain's
 * attempts; a message that isn't is its own original. So every row of a chain shows the same.
 */
export function chainRoots(clientMessageIds: readonly string[]): Map<string, string> {
  const roots = new Map<string, string>()
  for (const id of clientMessageIds) for (const link of chainOf(id)) if (!roots.has(link)) roots.set(link, id)
  // An attempt's own chain is part of its original's: map the links under it to the same root.
  const rootOf = (id: string) => {
    let root = id
    for (let i = 0; i < MAX_ATTEMPTS + 1 && roots.has(root); i++) root = roots.get(root)!
    return root
  }
  return new Map(clientMessageIds.map((id) => [id, rootOf(id)]))
}

let sending: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function setSending(id: string, on: boolean) {
  const next = new Set(sending)
  if (on) next.add(id)
  else next.delete(id)
  sending = next
  for (const listener of listeners) listener()
}

/**
 * Makes the next attempt for `original` with `send`, given its ID, if one may be made now.
 * The attempt's state then comes from the list and the server, not from here: this page only
 * knows it's on its way until the server answers. If the call doesn't reach the server, the
 * same link can be tried again with the same ID, so one that did reach it isn't made twice.
 */
export async function sendAgain(
  original: string,
  known: ReadonlyMap<string, SendAgainState>,
  send: (id: string) => Promise<SendAnswer>,
): Promise<SendAgainState | undefined> {
  const id = nextAttempt(original, known, sending)
  if (!id) return latestAttempt(original, known, sending)?.state
  setSending(id, true)
  try {
    return stateOf(await send(id))
  } catch {
    return undefined
  } finally {
    setSending(id, false)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The attempts on their way from this page. */
export const useSendingAgain = () => useSyncExternalStore(subscribe, () => sending)

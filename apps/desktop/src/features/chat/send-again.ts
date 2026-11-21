import { useSyncExternalStore } from 'react'

// Sending a failed or unconfirmed message again. The server decides (messages.retryStates and
// messages.sendAgain, client-api.md): which chain a send belongs to, where its latest attempt
// stands, whether another may be made, and that attempt's client message ID. This page only
// shows what it says, the same on every row of a chain, and knows which chains have an attempt
// on its way from here so a click meanwhile does nothing.

/**
 * Where a chain stands, by its latest attempt: on its way from here (`sending`); taken and
 * being sent (`going`); sent (`sent`); may have been sent (`maybe`); or failed (`failed`).
 */
export type SendAgainState = 'sending' | 'going' | 'sent' | 'maybe' | 'failed'

/** Where an attempt is, by its delivery state. */
export function fromDelivery(delivery: string | null | undefined): Exclude<SendAgainState, 'sending'> {
  switch (delivery) {
    case null:
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

/** What the server says of a chain (messages.retryStates). */
export interface RetryState {
  root: string
  latest: string | null
  delivery: string | null
  allowed: boolean
  nextId: string | null
}

/** A row's badge and whether it offers another attempt, from its chain's state. */
export function againView(
  state: RetryState | undefined,
  sending: ReadonlySet<string>,
): { state: SendAgainState | undefined; canTry: boolean } {
  if (!state) return { state: undefined, canTry: false }
  if (sending.has(state.root)) return { state: 'sending', canTry: false }
  return { state: state.latest ? fromDelivery(state.delivery) : undefined, canTry: state.allowed && !!state.nextId }
}

let sending: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function setSending(root: string, on: boolean) {
  const next = new Set(sending)
  if (on) next.add(root)
  else next.delete(root)
  sending = next
  for (const listener of listeners) listener()
}

/**
 * Makes the chain's next attempt with `send` (sealing for `state.nextId` and calling
 * messages.sendAgain), unless the server doesn't allow one or one is on its way from here.
 * Whether it was made is the server's answer; repeated clicks and other tabs make one.
 */
export async function sendAgain(
  state: RetryState | undefined,
  send: (nextId: string) => Promise<{ created: boolean }>,
): Promise<boolean> {
  if (!state?.allowed || !state.nextId || sending.has(state.root)) return false
  setSending(state.root, true)
  try {
    return (await send(state.nextId)).created
  } catch {
    return false
  } finally {
    setSending(state.root, false)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The chains with an attempt on its way from this page, by original. */
export const useSendingAgain = () => useSyncExternalStore(subscribe, () => sending)

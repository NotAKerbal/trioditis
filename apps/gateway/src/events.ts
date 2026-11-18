import type { BridgeEvent } from '@trioditis/core/bridge-protocol'
import { NETWORKS, type Network } from '@trioditis/core'
import type { Backend } from './backend.ts'

// POST /v1/events: a bridge host's events, applied in order. The answer acknowledges a
// sequence only once Convex has committed everything up to it. See
// docs/architecture/bridge-protocol.md, Events.

/** Matches the backend's limit per ingest call. */
export const CHUNK = 100

export type Reply = { status: number; body: unknown }

interface Batch {
  hostId: string
  network: Network
  events: BridgeEvent[]
}

const isText = (value: unknown) => typeof value === 'string' && value.length > 0

/**
 * The batch, if it is one. Every event needs a usable sequence number, without which the
 * order can't be kept; the rest of each event is checked by the backend, and an event it
 * can't use is quarantined without stopping the ones after.
 */
export function parseBatch(value: unknown): Batch | null {
  if (typeof value !== 'object' || value === null) return null
  const batch = value as Record<string, unknown>
  if (!isText(batch.hostId) || !NETWORKS.includes(batch.network as Network) || !Array.isArray(batch.events)) return null
  for (const event of batch.events as unknown[]) {
    if (typeof event !== 'object' || event === null) return null
    const { seq } = event as Record<string, unknown>
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) return null
  }
  return { hostId: batch.hostId as string, network: batch.network as Network, events: batch.events as BridgeEvent[] }
}

/**
 * Whether the event itself is the problem: the backend's validators refused it, or the Convex
 * client couldn't encode it. Anything else (the backend is down) is not the event's fault, and
 * nothing is quarantined for it.
 */
function isValidationError(error: unknown) {
  const text = String(error)
  return (
    text.includes('ArgumentValidationError') ||
    text.includes('is not a supported Convex type') ||
    /Field name .* (starts with|must only contain|is too long)/.test(text) ||
    text.includes('is not a valid Convex value')
  )
}

type Outcome = { ackedThrough: number } | { expectedSeq: number }

/**
 * Applies one chunk. If the backend's validators refuse it, applies its events one at a time
 * instead and quarantines the ones refused, so one malformed event doesn't stop the feed.
 */
async function applyChunk(backend: Backend, batch: Batch, events: BridgeEvent[]): Promise<Outcome> {
  const target = { hostId: batch.hostId, network: batch.network }
  try {
    return await backend.ingest({ ...target, events: events as never })
  } catch (error) {
    if (!isValidationError(error) || events.length === 0) throw error
  }
  let outcome: Outcome = { ackedThrough: 0 }
  for (const event of events) {
    try {
      outcome = await backend.ingest({ ...target, events: [event] as never })
    } catch (error) {
      if (!isValidationError(error)) throw error
      outcome = await backend.quarantineInvalid({ ...target, seq: event.seq, type: String(event.type ?? 'unknown') })
    }
    if ('expectedSeq' in outcome) return outcome
  }
  return outcome
}

/**
 * Applies a batch, a chunk at a time. An empty batch is the host's heartbeat: it answers with
 * the last sequence Convex has, so a restarted bridge host knows where to resume.
 */
export async function handleEvents(backend: Backend, value: unknown): Promise<Reply> {
  const batch = parseBatch(value)
  if (!batch) return { status: 400, body: { error: 'invalid_command' } }
  const events = [...batch.events].sort((a, b) => a.seq - b.seq)
  let start = 0
  let ackedThrough = 0
  do {
    const outcome = await applyChunk(backend, batch, events.slice(start, start + CHUNK))
    if ('expectedSeq' in outcome) return { status: 409, body: { expectedSeq: outcome.expectedSeq } }
    ackedThrough = outcome.ackedThrough
    start += CHUNK
  } while (start < events.length)
  return { status: 200, body: { ackedThrough } }
}

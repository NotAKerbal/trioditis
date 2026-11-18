import type { BridgeEvent } from '@trioditis/core/bridge-protocol'
import { NETWORKS, type Network } from '@trioditis/core'
import { convexToJson, type Value } from 'convex/values'
import { isEnvelope } from '@trioditis/backend/envelope'
import { bridgeEvent } from '@trioditis/backend/validators'
import type { Backend } from './backend.ts'
import { conforms } from './shape.ts'

// POST /v1/events: a bridge host's events, applied in order. The answer acknowledges a
// sequence only once Convex has committed everything up to it. See
// docs/architecture/bridge-protocol.md, Events.

/** Matches the backend's limit per ingest call. */
export const CHUNK = 100
/**
 * The most event bytes (as JSON) in one ingest call, well under Convex's limits on a call's
 * arguments and a mutation's writes.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024
/**
 * An event bigger than this can't be valid (a sealed object is at most 256 KiB, and IDs are
 * short), so it is quarantined without being sent.
 */
export const MAX_EVENT_BYTES = 1024 * 1024

export type Reply = { status: number; body: unknown }

interface Batch {
  hostId: string
  network: Network
  events: BridgeEvent[]
}

const isText = (value: unknown) => typeof value === 'string' && value.length > 0

/**
 * The batch, if it is one. Every event needs a usable sequence number, without which the
 * order can't be kept. The rest of each event is checked here (`sendable`) and again by the
 * backend, and an event either can't use is quarantined without stopping the ones after.
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

/** Whether the backend's validators refused the event itself (rather than being down). */
function isValidationError(error: unknown) {
  return error instanceof Error && error.message.includes('ArgumentValidationError')
}

/**
 * Whether the event can go to the backend: the Convex client can encode it, within the size
 * any event may have, it has exactly an event's shape, and what it carries sealed is an
 * envelope (canonical base64url, real key IDs). One that isn't (a stray field or a "ciphertext"
 * could be plaintext) is quarantined without being sent.
 */
function sendable(event: unknown) {
  try {
    if (Buffer.byteLength(JSON.stringify(convexToJson(event as Value))) > MAX_EVENT_BYTES) return false
  } catch {
    return false
  }
  if (!conforms(bridgeEvent, event)) return false
  const { sealed } = event as { sealed?: Parameters<typeof isEnvelope>[0] }
  return sealed === undefined || isEnvelope(sealed)
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'message',
  'edit',
  'reaction',
  'reactionRemove',
  'redaction',
  'receipt',
  'typing',
  'chat',
  'contact',
  'loginState',
  'loginStep',
  'sendStatus',
  'backfillDone',
])

/** The event's type for quarantine: a known type, or `unknown`, never what the event says. */
function typeOf(event: BridgeEvent) {
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' && EVENT_TYPES.has(type) ? type : 'unknown'
}

type Outcome = { ackedThrough: number } | { expectedSeq: number }

/**
 * Applies one chunk. If the backend's validators refuse it, applies its events one at a time
 * instead and quarantines the ones refused, so one malformed event doesn't stop the feed.
 */
async function applyChunk(backend: Backend, batch: Batch, events: BridgeEvent[]): Promise<Outcome> {
  const target = { hostId: batch.hostId, network: batch.network }
  // A chunk holding an event that can't be sent goes one event at a time from the start.
  if (events.every(sendable)) {
    try {
      return await ingestAll(backend, target, events)
    } catch (error) {
      if (!isValidationError(error) || events.length === 0) throw error
    }
  }
  let outcome: Outcome = { ackedThrough: 0 }
  for (const event of events) {
    let invalid = !sendable(event)
    if (!invalid) {
      try {
        outcome = await backend.ingest({ ...target, events: [event] as never })
      } catch (error) {
        if (!isValidationError(error)) throw error
        invalid = true
      }
    }
    if (invalid) outcome = await backend.quarantineInvalid({ ...target, seq: event.seq, type: typeOf(event) })
    if ('expectedSeq' in outcome) return outcome
  }
  return outcome
}

/**
 * Sends a chunk until the backend has applied all of it. The backend may stop partway, to stay
 * inside its transaction limits, and acknowledge only what it applied; the rest goes in the
 * next call. A call that makes no progress ends the loop, and the bridge host resends later.
 */
async function ingestAll(
  backend: Backend,
  target: { hostId: string; network: Network },
  events: BridgeEvent[],
): Promise<Outcome> {
  const last = events.at(-1)?.seq ?? 0
  let remaining = events
  let outcome: Outcome = await backend.ingest({ ...target, events: remaining as never })
  while ('ackedThrough' in outcome && outcome.ackedThrough < last) {
    const acked = outcome.ackedThrough
    const rest = remaining.filter((event) => event.seq > acked)
    if (rest.length === remaining.length) break
    remaining = rest
    outcome = await backend.ingest({ ...target, events: remaining as never })
  }
  return outcome
}

/** Splits events, in order, into chunks within both the count and the byte limit. */
export function chunk(events: BridgeEvent[]): BridgeEvent[][] {
  const chunks: BridgeEvent[][] = []
  let current: BridgeEvent[] = []
  let bytes = 0
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event) ?? '')
    if (current.length > 0 && (current.length >= CHUNK || bytes + size > CHUNK_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(event)
    bytes += size
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks
}

/**
 * Applies a batch, a chunk at a time. An empty batch is the host's heartbeat: it answers with
 * the last sequence Convex has, so a restarted bridge host knows where to resume.
 */
export async function handleEvents(backend: Backend, value: unknown): Promise<Reply> {
  const batch = parseBatch(value)
  if (!batch) return { status: 400, body: { error: 'invalid_command' } }
  const events = [...batch.events].sort((a, b) => a.seq - b.seq)
  let ackedThrough = 0
  for (const part of chunk(events)) {
    const outcome = await applyChunk(backend, batch, part)
    if ('expectedSeq' in outcome) return { status: 409, body: { expectedSeq: outcome.expectedSeq } }
    ackedThrough = outcome.ackedThrough
  }
  return { status: 200, body: { ackedThrough } }
}

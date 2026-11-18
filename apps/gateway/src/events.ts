import type { BridgeEvent, EventBatch } from '@trioditis/core/bridge-protocol'
import { NETWORKS } from '@trioditis/core'
import type { Backend } from './backend.ts'

// POST /v1/events: a bridge host's events, applied in order. The answer acknowledges a
// sequence only once Convex has committed everything up to it. See
// docs/architecture/bridge-protocol.md, Events.

/** Matches the backend's limit per ingest call. */
export const CHUNK = 100

export type Reply = { status: number; body: unknown }

export function parseBatch(value: unknown): EventBatch | null {
  if (typeof value !== 'object' || value === null) return null
  const batch = value as Partial<EventBatch>
  if (typeof batch.hostId !== 'string' || !batch.hostId) return null
  if (typeof batch.commandAddr !== 'string' || !/^https?:\/\//.test(batch.commandAddr)) return null
  if (!NETWORKS.includes(batch.network as never)) return null
  if (!Array.isArray(batch.events)) return null
  return batch as EventBatch
}

/**
 * Applies a batch, a chunk at a time. An empty batch is a handshake: it answers with the last
 * sequence Convex has, so a restarted bridge host knows where to resume.
 */
export async function handleEvents(backend: Backend, value: unknown): Promise<Reply> {
  const batch = parseBatch(value)
  if (!batch) return { status: 400, body: { error: 'Not an event batch' } }
  const events = [...batch.events].sort((a: BridgeEvent, b: BridgeEvent) => a.seq - b.seq)
  let start = 0
  let ackedThrough = 0
  do {
    const result = await backend.ingest({
      hostId: batch.hostId,
      network: batch.network,
      commandAddr: batch.commandAddr,
      events: events.slice(start, start + CHUNK) as never,
    })
    if ('expectedSeq' in result) return { status: 409, body: { expectedSeq: result.expectedSeq } }
    ackedThrough = result.ackedThrough
    start += CHUNK
  } while (start < events.length)
  return { status: 200, body: { ackedThrough } }
}

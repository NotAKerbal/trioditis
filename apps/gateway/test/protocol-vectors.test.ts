import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isEnvelope } from '@trioditis/backend/envelope'
import { bridgeEvent } from '@trioditis/backend/validators'
import { conforms } from '../src/shape.ts'

// The example events the Go bridge host checks itself against (written from the backend's
// validator by packages/backend/scripts/write-protocol-schema.ts). The gateway passes on
// exactly the valid ones and quarantines the rest, so both sides agree on every field.
type Vectors = { valid: { name: string; event: unknown }[]; invalid: { name: string; event: unknown }[] }

const vectors = JSON.parse(
  readFileSync(new URL('../../bridge-host/internal/protocol/testdata/event-vectors.json', import.meta.url), 'utf8'),
) as Vectors

describe('bridge protocol example events', () => {
  it.each(vectors.valid.map((vector) => [vector.name, vector.event]))('passes on %s', (_name, event) => {
    expect(conforms(bridgeEvent, event)).toBe(true)
    const { sealed } = event as { sealed?: Parameters<typeof isEnvelope>[0] }
    if (sealed !== undefined) expect(isEnvelope(sealed)).toBe(true)
  })

  it.each(vectors.invalid.map((vector) => [vector.name, vector.event]))('refuses %s', (_name, event) => {
    expect(conforms(bridgeEvent, event)).toBe(false)
  })
})

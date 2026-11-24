// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCHEMA_FILE, VECTORS_FILE, buildSchema, buildVectors } from '../scripts/protocol-schema.ts'

const onDisk = (file: string) =>
  JSON.parse(readFileSync(new URL(file, new URL('../scripts/', import.meta.url)), 'utf8'))

// The bridge host reads the protocol's event schema from these files, not from the validator,
// so a validator change that isn't written out would leave it checking events by the old rules.
describe('protocol schema', () => {
  it('is up to date with the bridgeEvent validator (pnpm --filter @trioditis/backend protocol-schema)', () => {
    expect(onDisk(SCHEMA_FILE)).toEqual(buildSchema())
    expect(onDisk(VECTORS_FILE)).toEqual(buildVectors())
  })

  it('has an example of every event type, with and without its optional fields, and of every value', () => {
    const schema = buildSchema()
    const { valid, invalid } = buildVectors()
    for (const [type, shape] of Object.entries(schema.events)) {
      const examples = valid.filter((vector) => vector.event.type === type)
      expect(examples.slice(0, 2).map((vector) => Object.keys(vector.event).length)).toEqual([
        schema.common.length + shape.required.length + shape.optional.length,
        schema.common.length + shape.required.length,
      ])
      for (const [path, values] of Object.entries(shape.values)) {
        for (const value of values) {
          expect(examples.some((vector) => vector.name === `${type} with ${path} ${JSON.stringify(value)}`)).toBe(true)
        }
      }
      // One for each required field it leaves out, and one with a field it doesn't have.
      const refused = invalid.filter((vector) => vector.event.type === type)
      expect(refused.length).toBe(schema.common.length - 1 + shape.required.length + 1)
    }
  })
})

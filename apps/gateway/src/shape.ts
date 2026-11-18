import type { GenericValidator } from 'convex/values'

// Checks a value against a Convex validator here, before it is sent. The backend checks it
// again; this is so a malformed event (one with a stray plaintext field, say) never leaves
// the gateway at all.

type Node = {
  kind: string
  isOptional?: 'optional' | 'required'
  fields?: Record<string, Node>
  members?: Node[]
  element?: Node
  key?: Node
  value?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function matches(node: Node, value: unknown): boolean {
  switch (node.kind) {
    case 'string':
    case 'id':
      return typeof value === 'string'
    case 'float64':
      return typeof value === 'number'
    case 'int64':
      return typeof value === 'bigint'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'literal':
      return value === node.value
    case 'any':
      return true
    case 'array':
      return Array.isArray(value) && value.every((item) => matches(node.element!, item))
    case 'record':
      return (
        isRecord(value) &&
        Object.entries(value).every(([key, item]) => matches(node.key!, key) && matches(node.value as Node, item))
      )
    case 'union':
      return node.members!.some((member) => matches(member, value))
    case 'object': {
      if (!isRecord(value)) return false
      const fields = node.fields!
      // No field the validator doesn't know, nested or not: that is where plaintext would hide.
      if (Object.keys(value).some((key) => !Object.hasOwn(fields, key))) return false
      return Object.entries(fields).every(([key, field]) =>
        value[key] === undefined ? field.isOptional === 'optional' : matches(field, value[key]),
      )
    }
    default:
      // A kind this check doesn't know (bytes, say) fails closed: the event is quarantined
      // rather than sent unchecked. Teach `matches` the kind before an event uses it.
      return false
  }
}

/** Whether `value` has exactly the shape `validator` allows. */
export function conforms(validator: GenericValidator, value: unknown): boolean {
  return matches(validator as unknown as Node, value)
}

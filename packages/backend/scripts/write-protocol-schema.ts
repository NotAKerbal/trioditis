// Writes the bridge protocol's event schema and example events for the Go bridge host
// (scripts/protocol-schema.ts). Run with `pnpm --filter @trioditis/backend protocol-schema`
// after changing the bridgeEvent validator or the sealed size limits, and commit both files.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_FILE, VECTORS_FILE, buildSchema, buildVectors } from './protocol-schema.ts'

for (const [file, content] of [
  [SCHEMA_FILE, buildSchema()],
  [VECTORS_FILE, buildVectors()],
] as const) {
  const path = new URL(file, import.meta.url)
  mkdirSync(dirname(path.pathname), { recursive: true })
  writeFileSync(path, JSON.stringify(content, null, 2) + '\n')
}

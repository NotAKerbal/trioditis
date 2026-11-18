// Prepares a development stack: generates the server's secrets and key pairs once into
// .data/dev.env (git-ignored, readable only by you), and sets the ones the Convex deployment
// needs on it. Run after `pnpm --filter @trioditis/backend dev` has started a deployment:
//
//   node scripts/dev-setup.ts
//
// The gateway (`pnpm --filter @trioditis/gateway dev`) and the bridge host read .data/dev.env.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPair, ready, toBase64Url } from '@trioditis/crypto'

const root = new URL('..', import.meta.url)
const envFile = new URL('.data/dev.env', root)

function parse(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) values.set(match[1]!, match[2]!)
  }
  return values
}

await ready()
const env = existsSync(envFile) ? parse(readFileSync(envFile, 'utf8')) : new Map<string, string>()
const secret = () => randomBytes(32).toString('base64url')
function keyPair(name: string) {
  if (env.has(`${name}_PUBLIC_KEY`) && env.has(`${name}_PRIVATE_KEY`)) return
  const pair = generateKeyPair()
  env.set(`${name}_PUBLIC_KEY`, toBase64Url(pair.publicKey))
  env.set(`${name}_PRIVATE_KEY`, toBase64Url(pair.privateKey))
}

const defaults: Record<string, () => string> = {
  CONVEX_URL: () => 'http://127.0.0.1:3210',
  SITE_URL: () => 'http://127.0.0.1:3000',
  GATEWAY_SECRET: secret,
  TRIODITIS_INTERNAL_TOKEN: secret,
  TRIODITIS_SETUP_TOKEN: secret,
  TRIODITIS_NETWORKS: () => 'whatsapp,fake',
  GATEWAY_INTERNAL_ADDR: () => '127.0.0.1:8601',
  GATEWAY_URL: () => 'http://127.0.0.1:8601',
}
for (const [name, make] of Object.entries(defaults)) if (!env.has(name)) env.set(name, make())
keyPair('BRIDGE')
keyPair('AGENT_ACCESS')

mkdirSync(new URL('.data', root), { recursive: true })
writeFileSync(envFile, [...env].map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 })
chmodSync(envFile, 0o600)
console.log('Wrote .data/dev.env')

// What the Convex deployment reads. Private keys stay out of it until a function needs one.
const forConvex = [
  'SITE_URL',
  'GATEWAY_SECRET',
  'TRIODITIS_SETUP_TOKEN',
  'TRIODITIS_NETWORKS',
  'BRIDGE_PUBLIC_KEY',
  'AGENT_ACCESS_PUBLIC_KEY',
]
const backend = new URL('packages/backend/', root)
for (const name of forConvex) {
  execFileSync('npx', ['convex', 'env', 'set', name, env.get(name)!], {
    cwd: backend,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
console.log(`Set ${forConvex.join(', ')} on the Convex deployment`)
console.log(`Create the admin account with the setup token in .data/dev.env (TRIODITIS_SETUP_TOKEN).`)

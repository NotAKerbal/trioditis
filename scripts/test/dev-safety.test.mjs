// What keeps `pnpm dev` on this checkout's own local backend: the Convex CLI's deployment
// variables are stripped from its environment, and a checkout whose packages/backend points at
// any other backend is refused before anything is pushed or set.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertLocalBackend } from '../lib.mjs'

const backend = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'trioditis-backend-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}
const configured = { '.convex/local/default/config.json': '{}' }

void test('accepts this checkout’s anonymous local backend', () => {
  assertLocalBackend({ dir: backend({ ...configured, '.env.local': 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n' }) })
})

void test('accepts a checkout with no backend yet, only while creating it', () => {
  const dir = backend({})
  assertLocalBackend({ dir, requireConfigured: false })
  assert.throws(() => assertLocalBackend({ dir }), /\.env\.local is missing/)
})

void test('refuses a cloud or self-hosted deployment in .env.local', () => {
  for (const deployment of ['dev:happy-cat-123', 'prod:spotted-chihuahua-840', 'local:someone-else']) {
    const dir = backend({ ...configured, '.env.local': `CONVEX_DEPLOYMENT=${deployment}\n` })
    assert.throws(() => assertLocalBackend({ dir }), /not this checkout's local backend/)
  }
  const selfHosted = backend({ ...configured, '.env.local': 'CONVEX_SELF_HOSTED_URL=https://convex.example.com\n' })
  assert.throws(() => assertLocalBackend({ dir: selfHosted }), /no deployment/)
})

void test('refuses a CONVEX_ variable in another dotenv file', () => {
  const dir = backend({
    ...configured,
    '.env.local': 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n',
    '.env': 'CONVEX_DEPLOY_KEY=prod:x|y\n',
  })
  assert.throws(() => assertLocalBackend({ dir }), /\.env sets a CONVEX_ variable/)
})

void test('strips every deployment-selecting variable from the local backend’s commands', () => {
  const selectors = {
    CONVEX_DEPLOY_KEY: 'prod:x|secret',
    CONVEX_DEPLOYMENT: 'dev:happy-cat-123',
    CONVEX_URL: 'https://happy-cat-123.convex.cloud',
    CONVEX_SELF_HOSTED_URL: 'https://convex.example.com',
    CONVEX_SELF_HOSTED_ADMIN_KEY: 'admin',
    CONVEX_SOMETHING_NEW: 'x',
  }
  const script = `
    import { env, localConvex } from './scripts/lib.mjs'
    const child = env(localConvex.env, localConvex.unset)
    console.log(JSON.stringify(Object.keys(child).filter((name) => name.startsWith('CONVEX_'))))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, ...selectors },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ['CONVEX_AGENT_MODE'])
})

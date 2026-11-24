// Vercel's Ignored Build Step (scripts/vercel-ignore.mjs): which deployments build, and that it
// only ever exits 0 or 1, since Vercel fails the deployment on any other code.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, sites } from '../vercel-ignore.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(repoRoot, 'scripts/vercel-ignore.mjs')

let dir
let first // touches the site only
let second // touches the docs only
let third // touches the lockfile only
const sha = (ref) => spawnSync('git', ['-C', dir, 'rev-parse', ref], { encoding: 'utf8' }).stdout.trim()

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'vercel-ignore-'))
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir })
    assert.equal(result.status, 0, String(result.stderr))
  }
  const commit = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
    git('add', '.')
    git('commit', '-qm', file)
    return sha('HEAD')
  }
  git('init', '-q')
  commit('pnpm-lock.yaml', 'a\n')
  commit('apps/desktop/main.ts', 'a\n')
  first = commit('apps/site/index.html', 'a\n')
  second = commit('apps/docs/index.md', 'a\n')
  third = commit('pnpm-lock.yaml', 'b\n')
})

after(() => rmSync(dir, { recursive: true, force: true }))

const env = (previous, current) => ({
  VERCEL_ENV: 'production',
  VERCEL_GIT_PREVIOUS_SHA: previous,
  VERCEL_GIT_COMMIT_SHA: current,
})

void test('a site skips a commit that changes none of its files, and builds one that does', () => {
  assert.equal(decide('site', env(first, third), dir).build, false)
  assert.equal(decide('docs', env(first, second), dir).build, true)
  // The docs install their dependencies; the site has none.
  assert.equal(decide('docs', env(second, third), dir).build, true)
  assert.match(decide('docs', env(second, third), dir).reason, /pnpm-lock\.yaml/)
})

void test('anything it can’t tell builds', () => {
  const missing = 'f'.repeat(40)
  assert.equal(decide('site', env(undefined, third), dir).build, true)
  assert.equal(decide('site', env(first, undefined), dir).build, true)
  // The last deployed commit has fallen out of Vercel's shallow clone: the failure behind the
  // errored deployments of 24 November 2026.
  assert.equal(decide('site', env(missing, third), dir).build, true)
  assert.match(decide('site', env(missing, third), dir).reason, /not in Vercel's clone/)
  assert.equal(decide('site', env(first, missing), dir).build, true)
  assert.equal(decide('site', env('--output=x', third), dir).build, true)
  assert.equal(decide('site', { ...env(first, third), TRIODITIS_PREVIEW: '1' }, dir).build, true)
  assert.equal(decide('nope', env(first, third), dir).build, true)
  assert.equal(decide('site', env(first, third), join(dir, 'not-a-repo')).build, true)
})

void test('the web app skips production, which is self-hosted, and only the web app does', () => {
  assert.equal(decide('web', env(first, first), dir).build, false)
  assert.equal(decide('web', { ...env(first, third), VERCEL_ENV: 'preview' }, dir).build, true)
  assert.equal(decide('docs', env(undefined, third), dir).build, true)
})

void test('it exits 0 to skip and 1 to build, whatever goes wrong', () => {
  const run = (args, extra) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, VERCEL_ENV: 'production', ...extra },
    }).status
  // These run against this checkout, where neither commit exists.
  assert.equal(run(['site'], { VERCEL_GIT_PREVIOUS_SHA: 'f'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'e'.repeat(40) }), 1)
  assert.equal(run(['site'], {}), 1)
  assert.equal(run([], {}), 1)
  assert.equal(run(['web'], {}), 0)
  // Without git at all.
  assert.equal(
    run(['site'], {
      PATH: '/nonexistent',
      VERCEL_GIT_PREVIOUS_SHA: 'f'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'e'.repeat(40),
    }),
    1,
  )
})

void test('each project’s vercel.json runs it for its own site and deploys only from dev', () => {
  for (const [file, command, site] of [
    ['apps/site/vercel.json', 'node ../../scripts/vercel-ignore.mjs site', 'site'],
    ['apps/docs/vercel.json', 'node ../../scripts/vercel-ignore.mjs docs', 'docs'],
  ]) {
    const config = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'))
    assert.equal(config.ignoreCommand, command, file)
    assert.deepEqual(config.git?.deploymentEnabled, { '**': false, dev: true }, file)
    assert.ok(sites[site].includes(dirname(file)), file)
  }
  assert.equal(
    JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')).ignoreCommand,
    'node scripts/vercel-ignore.mjs web',
  )
})

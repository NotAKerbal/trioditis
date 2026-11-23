// CI's choice of slow jobs (scripts/ci-changes.mjs): what a pull request's files make it run.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { areas, changedFiles } from '../ci-changes.mjs'

void test('a change to the bundle runs its tests and builds its images', () => {
  assert.deepEqual(areas(['deploy/trioditis', 'release-notes/x.md']), { deploy: true, images: true })
  assert.deepEqual(areas(['deploy/docker/web.Dockerfile']), { deploy: true, images: true })
})

void test('a change to the bundle’s tests runs them and builds nothing', () => {
  assert.deepEqual(areas(['deploy/test/keys.sh']), { deploy: true, images: false })
})

void test('a change to the app builds the images but skips the bundle’s tests', () => {
  for (const file of ['apps/desktop/src/main.tsx', 'packages/backend/convex/schema.ts', 'apps/bridge-host/go.mod']) {
    assert.deepEqual(areas([file, 'release-notes/x.md']), { deploy: false, images: true }, file)
  }
  // The web image's install reads every package's package.json, the docs site's too.
  assert.deepEqual(areas(['apps/docs/package.json']), { deploy: false, images: true })
  assert.deepEqual(areas(['pnpm-lock.yaml']), { deploy: false, images: true })
  // Markdown inside a package can still be part of a build: Vite copies apps/desktop/public.
  for (const file of ['apps/desktop/public/notes.md', 'apps/bridge-host/README.md', 'packages/ui/README.md']) {
    assert.deepEqual(areas([file]), { deploy: false, images: true }, file)
  }
})

void test('docs, the site, notes and other workflows run neither', () => {
  const files = [
    'apps/docs/src/content/docs/contributing/workflow.md',
    'apps/site/index.html',
    'release-notes/x.md',
    'README.md',
    'scripts/test/release-notes.test.mjs',
    '.github/workflows/desktop-release.yml',
  ]
  assert.deepEqual(areas(files), { deploy: false, images: false })
})

void test('a change to CI’s own choices, or nothing it can see, runs everything', () => {
  assert.deepEqual(areas(['scripts/ci-changes.mjs']), { deploy: true, images: true })
  assert.deepEqual(areas(['.github/workflows/checks.yml']), { deploy: true, images: true })
  assert.deepEqual(areas([]), { deploy: true, images: true })
})

void test('the changed files come from git, and an unknown base is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir })
    assert.equal(result.status, 0, String(result.stderr))
  }
  try {
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    mkdirSync(join(dir, 'deploy'))
    writeFileSync(join(dir, 'deploy', 'name with space'), 'b\n')
    git('add', '.')
    git('commit', '-qm', 'change')
    assert.deepEqual(changedFiles('HEAD^', dir), ['deploy/name with space'])
    assert.equal(changedFiles('no-such-ref', dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

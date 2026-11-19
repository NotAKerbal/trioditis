// Keeps the bridge host's copy of mautrix-signal (apps/bridge-host/third_party/mautrix-signal)
// equal to upstream, at the version apps/bridge-host/go.mod requires, plus one patch
// (third_party/mautrix-signal.patch). third_party/README.md says why there is a copy.
//
//   node scripts/signal-fork.mjs check    fails unless the copy is upstream plus the patch
//   node scripts/signal-fork.mjs diff     rewrites the patch from the copy, after editing it
//   node scripts/signal-fork.mjs update   recopies upstream and applies the patch, after
//                                         changing the version in go.mod
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bridgeDir, capture, env, goEnv, removeFromCheckout, run } from './lib.mjs'

const MODULE = 'go.mau.fi/mautrix-signal'
const copyDir = resolve(bridgeDir, 'third_party/mautrix-signal')
const patchFile = resolve(bridgeDir, 'third_party/mautrix-signal.patch')
// Upstream's own .gitignore leaves .idea out of the repository, so the copy can't keep it.
const LEFT_OUT = new Set(['.idea'])

/** The version go.mod requires, which the replace directive swaps for the copy. */
function upstreamVersion() {
  const goMod = readFileSync(resolve(bridgeDir, 'go.mod'), 'utf8')
  const version = /^\s*go\.mau\.fi\/mautrix-signal (v\S+)/m.exec(goMod)?.[1]
  if (!version) throw new Error(`apps/bridge-host/go.mod doesn't require ${MODULE}.`)
  return version
}

/**
 * Fails unless Go builds the bridge host against the copy, at `version`: with the replace
 * directive gone, or overridden (in go.work, say), this script would check one tree while Go
 * built another.
 */
function assertBuiltFromCopy(version) {
  const info = JSON.parse(capture('go', ['list', '-m', '-json', MODULE], { cwd: bridgeDir, env: goEnv(), quiet: true }))
  if (info.Version !== version || !info.Replace?.Dir || realpathSync(info.Replace.Dir) !== realpathSync(copyDir)) {
    throw new Error(
      `Go builds ${MODULE} from ${info.Replace?.Dir ?? `${info.Version}, not replaced`}, not from ` +
        `apps/bridge-host/third_party/mautrix-signal at ${version}. Keep the replace directive in apps/bridge-host/go.mod.`,
    )
  }
}

/**
 * Upstream's source at `version`, freshly downloaded into an empty module cache in `scratch`
 * and checked against Go's checksum database. An existing cache isn't used: Go checks a
 * module's zip when it downloads it, not the extracted files a later download reuses.
 */
function upstreamDir(version, scratch) {
  const cache = join(scratch, 'modcache')
  mkdirSync(cache)
  const info = capture('go', ['mod', 'download', '-json', `${MODULE}@${version}`], {
    // Outside any module, and with every setting that could skip the checksum database set.
    cwd: scratch,
    env: {
      ...goEnv(),
      GOMODCACHE: cache,
      GOFLAGS: '-modcacherw',
      GOWORK: 'off',
      GOSUMDB: 'sum.golang.org',
      GONOSUMDB: '',
      GONOSUMCHECK: '',
      GOPRIVATE: '',
      GOINSECURE: '',
    },
    quiet: true,
  })
  const dir = JSON.parse(info).Dir
  if (!dir) throw new Error(`go mod download gave no directory for ${MODULE}@${version}.`)
  return dir
}

/**
 * Copies a module tree to `to` with plain permissions (the module cache's files are read-only,
 * and git tracks only the executable bit), so a diff of two copies shows content alone.
 */
function copyTree(from, to) {
  cpSync(from, to, { recursive: true, filter: (path) => !LEFT_OUT.has(path.slice(from.length + 1)) })
  const walk = (dir) => {
    chmodSync(dir, 0o755)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else chmodSync(path, 0o644)
    }
  }
  walk(to)
}

/** The patch that turns upstream into the copy, as `git apply -p1` takes it. */
function currentPatch(upstream, scratch) {
  copyTree(upstream, join(scratch, 'a'))
  copyTree(copyDir, join(scratch, 'b'))
  // Every machine must write the same patch, so no configuration is read (scratch is outside
  // any repository, and the user's and system's files are skipped), and the options that
  // change a diff's text are given: full hashes, the default algorithm, three lines of context.
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--full-index',
      '--diff-algorithm=myers',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-prefix',
      '--unified=3',
      'a',
      'b',
    ],
    {
      cwd: scratch,
      env: env({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, [
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT',
        'GIT_DIFF_OPTS',
        'GIT_EXTERNAL_DIFF',
        'GIT_DIR',
        'GIT_WORK_TREE',
      ]),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  // git diff exits 1 when the trees differ, which they should.
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff failed: ${result.stderr}`)
  return result.stdout
}

function main(command) {
  if (!['check', 'diff', 'update'].includes(command))
    throw new Error('Usage: node scripts/signal-fork.mjs check|diff|update')
  const version = upstreamVersion()
  const scratch = mkdtempSync(join(tmpdir(), 'trioditis-signal-fork-'))
  try {
    const upstream = upstreamDir(version, scratch)
    if (command === 'check') {
      assertBuiltFromCopy(version)
      const want = readFileSync(patchFile, 'utf8')
      if (currentPatch(upstream, scratch) !== want) {
        throw new Error(
          `apps/bridge-host/third_party/mautrix-signal isn't ${MODULE} ${version} plus mautrix-signal.patch. ` +
            'After editing the copy, run `node scripts/signal-fork.mjs diff`; after changing the version, `update`.',
        )
      }
      console.log(`The copy is ${MODULE} ${version} plus mautrix-signal.patch.`)
    } else if (command === 'diff') {
      writeFileSync(patchFile, currentPatch(upstream, scratch))
      console.log(`Wrote ${patchFile}.`)
    } else if (command === 'update') {
      const fresh = join(scratch, 'fresh')
      copyTree(upstream, fresh)
      // In a fresh directory outside any repository, git apply works like patch(1). A hunk that
      // no longer applies stops here, before the copy is touched.
      run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: fresh })
      removeFromCheckout(copyDir)
      cpSync(fresh, copyDir, { recursive: true })
      console.log(`Copied ${MODULE} ${version} and applied mautrix-signal.patch.`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  main(process.argv[2])
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

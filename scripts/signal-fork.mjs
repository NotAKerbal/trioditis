// Keeps the bridge host's patched copies of upstream modules (apps/bridge-host/third_party:
// mautrix-signal, and mautrix, whose bridgev2 the connectors run on) equal to upstream, at the
// version apps/bridge-host/go.mod requires, plus one patch each (third_party/<name>.patch).
// third_party/README.md says why there is each copy.
//
//   node scripts/signal-fork.mjs check          fails unless every copy is upstream plus its patch
//   node scripts/signal-fork.mjs diff [name]    rewrites a patch (or all) from its copy, after editing it
//   node scripts/signal-fork.mjs update [name]  recopies upstream and applies the patch, after
//                                               changing the version in go.mod
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

// Upstream's own .gitignore files leave .idea out of their repositories, so a copy can't keep it.
const LEFT_OUT = new Set(['.idea'])
const FORKS = [
  { name: 'mautrix-signal', module: 'go.mau.fi/mautrix-signal' },
  { name: 'mautrix', module: 'maunium.net/go/mautrix' },
].map((fork) => ({
  ...fork,
  copyDir: resolve(bridgeDir, 'third_party', fork.name),
  patchFile: resolve(bridgeDir, 'third_party', `${fork.name}.patch`),
}))

/** The version go.mod requires, which the replace directive swaps for the copy. */
function upstreamVersion({ module }) {
  const goMod = readFileSync(resolve(bridgeDir, 'go.mod'), 'utf8')
  const escaped = module.replace(/[.]/g, '\\.')
  const version = new RegExp(`^\\s*${escaped} (v\\S+)`, 'm').exec(goMod)?.[1]
  if (!version) throw new Error(`apps/bridge-host/go.mod doesn't require ${module}.`)
  return version
}

/**
 * Fails unless Go builds the bridge host against the copy, at `version`: with the replace
 * directive gone, or overridden (in go.work, say), this script would check one tree while Go
 * built another.
 */
function assertBuiltFromCopy({ module, copyDir, name }, version) {
  const info = JSON.parse(capture('go', ['list', '-m', '-json', module], { cwd: bridgeDir, env: goEnv(), quiet: true }))
  if (info.Version !== version || !info.Replace?.Dir || realpathSync(info.Replace.Dir) !== realpathSync(copyDir)) {
    throw new Error(
      `Go builds ${module} from ${info.Replace?.Dir ?? `${info.Version}, not replaced`}, not from ` +
        `apps/bridge-host/third_party/${name} at ${version}. Keep the replace directive in apps/bridge-host/go.mod.`,
    )
  }
}

/**
 * Upstream's source at `version`, freshly downloaded into an empty module cache in `scratch`
 * and checked against Go's checksum database. An existing cache isn't used: Go checks a
 * module's zip when it downloads it, not the extracted files a later download reuses.
 */
function upstreamDir({ module }, version, scratch) {
  const cache = join(scratch, 'modcache')
  mkdirSync(cache)
  const info = capture('go', ['mod', 'download', '-json', `${module}@${version}`], {
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
  if (!dir) throw new Error(`go mod download gave no directory for ${module}@${version}.`)
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
function currentPatch({ copyDir }, upstream, scratch) {
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

function runFork(command, fork) {
  const { name, module, copyDir, patchFile } = fork
  const version = upstreamVersion(fork)
  const scratch = mkdtempSync(join(tmpdir(), `trioditis-${name}-fork-`))
  try {
    const upstream = upstreamDir(fork, version, scratch)
    if (command === 'check') {
      assertBuiltFromCopy(fork, version)
      const want = readFileSync(patchFile, 'utf8')
      if (currentPatch(fork, upstream, scratch) !== want) {
        throw new Error(
          `apps/bridge-host/third_party/${name} isn't ${module} ${version} plus ${name}.patch. ` +
            `After editing the copy, run \`node scripts/signal-fork.mjs diff ${name}\`; after changing the version, \`update ${name}\`.`,
        )
      }
      console.log(`The copy is ${module} ${version} plus ${name}.patch.`)
    } else if (command === 'diff') {
      writeFileSync(patchFile, currentPatch(fork, upstream, scratch))
      console.log(`Wrote ${patchFile}.`)
    } else if (command === 'update') {
      const fresh = join(scratch, 'fresh')
      copyTree(upstream, fresh)
      // In a fresh directory outside any repository, git apply works like patch(1). A hunk that
      // no longer applies stops here, before the copy is touched.
      run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: fresh })
      removeFromCheckout(copyDir)
      cpSync(fresh, copyDir, { recursive: true })
      console.log(`Copied ${module} ${version} and applied ${name}.patch.`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function main(command, only) {
  if (!['check', 'diff', 'update'].includes(command))
    throw new Error('Usage: node scripts/signal-fork.mjs check|diff|update [mautrix-signal|mautrix]')
  const forks = only ? FORKS.filter((fork) => fork.name === only) : FORKS
  if (forks.length === 0) throw new Error(`No copy called ${only}: ${FORKS.map((fork) => fork.name).join(', ')}.`)
  for (const fork of forks) runFork(command, fork)
}

try {
  main(process.argv[2], process.argv[3])
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// Runs what CI runs (.github/workflows/checks.yml), so a branch can be checked before it's
// pushed: the TypeScript typecheck, lint, format, tests and builds, the release notes' format,
// and the bridge host's Go vet and tests. CI's slow jobs, the deploy bundle's tests and the
// server's images, need Docker and take a while, so they run only when asked for. Prints a
// summary and exits non-zero if any check failed.
//
//   pnpm check            the checks every pull request runs
//   pnpm check --deploy   and the deploy bundle's tests (sh deploy/test/run.sh)
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bridgeDir, env, goEnv, root, step } from './lib.mjs'

// CI runs `pnpm typecheck` and `pnpm build`; here the docs site's typecheck and build run on
// their own. Astro needs a CPU with AVX, and on one without (some virtual machines) it dies with
// an illegal instruction, which says nothing about the branch and would stop the other
// packages' runs with it.
const docs = (task) => ({
  name: `${task} (the docs)`,
  cmd: 'pnpm',
  args: ['--dir', 'apps/docs', 'run', task],
  illegalInstruction: `this CPU can't run Astro, so only CI runs the docs' ${task}`,
})
const allButDocs = (task) => ({
  name: `${task} (all but the docs)`,
  cmd: 'pnpm',
  args: ['exec', 'turbo', 'run', task, '--filter=!@trioditis/docs'],
})

const checks = [
  allButDocs('typecheck'),
  docs('typecheck'),
  { name: 'pnpm lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'pnpm format:check', cmd: 'pnpm', args: ['format:check'] },
  { name: 'pnpm test', cmd: 'pnpm', args: ['test'] },
  { name: 'pnpm test:scripts', cmd: 'pnpm', args: ['test:scripts'] },
  allButDocs('build'),
  docs('build'),
  // CI also checks that a pull request adds a note; that needs the pull request's base.
  { name: 'release notes', cmd: 'node', args: ['scripts/release-notes.mjs', 'check'] },
]
let go = null
if (existsSync(resolve(bridgeDir, 'go.mod'))) {
  try {
    go = goEnv()
    checks.push(
      { name: 'go vet ./...', cmd: 'go', args: ['vet', './...'], cwd: bridgeDir, env: go },
      // Signal's code is only compiled with this tag; vetting needs no libsignal to link.
      {
        name: 'go vet -tags libsignal ./...',
        cmd: 'go',
        args: ['vet', '-tags', 'libsignal', './...'],
        cwd: bridgeDir,
        env: go,
      },
      { name: 'go test ./...', cmd: 'go', args: ['test', './...'], cwd: bridgeDir, env: go },
      // The patched mautrix-signal and mautrix copies are upstream plus their patches, nothing else.
      {
        name: 'mautrix-signal and mautrix copies match their patches',
        cmd: 'node',
        args: ['scripts/signal-fork.mjs', 'check'],
        env: go,
      },
    )
  } catch (error) {
    checks.push({ name: 'go vet, go test', blocked: error.message })
  }
}

if (process.argv.includes('--deploy')) {
  checks.push({ name: 'deploy bundle tests', cmd: 'sh', args: ['deploy/test/run.sh'] })
}

// 132 is a shell's exit status for a child killed by SIGILL.
const illegal = (result) => result.signal === 'SIGILL' || result.status === 132

const results = []
for (const check of checks) {
  if (check.blocked) {
    results.push([check.name, 'Blocked', check.blocked])
    continue
  }
  step(check.name)
  const result = spawnSync(check.cmd, check.args, { cwd: check.cwd ?? root, env: env(check.env), stdio: 'inherit' })
  if (result.status === 0) results.push([check.name, 'Passed', ''])
  else if (check.illegalInstruction && illegal(result)) results.push([check.name, 'Blocked', check.illegalInstruction])
  else results.push([check.name, 'Failed', ''])
}

console.log('\n\x1b[1mChecks\x1b[0m')
for (const [name, status, detail] of results) console.log(`  ${status.padEnd(8)} ${name}${detail ? `: ${detail}` : ''}`)
process.exit(results.every(([, status]) => status === 'Passed') ? 0 : 1)

// Runs exactly what CI runs (.github/workflows/checks.yml), so a branch can be checked locally
// when GitHub Actions can't run: the TypeScript typecheck, lint and tests, and the bridge
// host's Go vet and tests. Prints a summary and exits non-zero if any check failed.
//
//   pnpm check
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bridgeDir, env, goEnv, root, step } from './lib.mjs'

const checks = [
  { name: 'pnpm typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'pnpm lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'pnpm test', cmd: 'pnpm', args: ['test'] },
  { name: 'pnpm test:scripts', cmd: 'pnpm', args: ['test:scripts'] },
]
let go = null
if (existsSync(resolve(bridgeDir, 'go.mod'))) {
  try {
    go = goEnv()
    checks.push(
      { name: 'go vet ./...', cmd: 'go', args: ['vet', './...'], cwd: bridgeDir, env: go },
      { name: 'go test ./...', cmd: 'go', args: ['test', './...'], cwd: bridgeDir, env: go },
    )
  } catch (error) {
    checks.push({ name: 'go vet, go test', blocked: error.message })
  }
}

const results = []
for (const check of checks) {
  if (check.blocked) {
    results.push([check.name, 'Blocked', check.blocked])
    continue
  }
  step(check.name)
  const result = spawnSync(check.cmd, check.args, { cwd: check.cwd ?? root, env: env(check.env), stdio: 'inherit' })
  results.push([check.name, result.status === 0 ? 'Passed' : 'Failed', ''])
}

console.log('\n\x1b[1mChecks\x1b[0m')
for (const [name, status, detail] of results) console.log(`  ${status.padEnd(8)} ${name}${detail ? `: ${detail}` : ''}`)
process.exit(results.every(([, status]) => status === 'Passed') ? 0 : 1)

// Which of CI's slow jobs a pull request needs (.github/workflows/checks.yml). The deploy bundle's
// tests take about eight minutes and the server's images longer, so a pull request that can't
// affect them skips them. Pushes to dev and main, and the nightly run, always run everything,
// so a skip here never lets a broken bundle reach a server unseen.
//
//   node scripts/ci-changes.mjs <base>
//     Decides from the files changed between <base> and HEAD.
//   node scripts/ci-changes.mjs all
//     Runs everything.
//
// Prints `deploy=true|false` and `images=true|false`, and appends them to $GITHUB_OUTPUT when
// it's set. Anything it can't tell runs: a failed diff, or no changed files at all.
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Changes to CI itself rerun what it decides.
const CI = ['.github/workflows/checks.yml', 'scripts/ci-changes.mjs']

// The deploy tests (deploy/test) copy the bundle out of deploy/ and run it; nothing outside
// it reaches them.
const DEPLOY = [/^deploy\//]

// The images (deploy/docker) are built from nearly the whole checkout: web.Dockerfile copies
// all of it, its install reads every package's package.json, and any file under a package can end up in a
// build (Vite copies apps/desktop/public as it is, whatever the file's type). These are the
// files no image's build reads.
const NOT_IMAGES = [
  /^apps\/docs\/src\//,
  /^apps\/site\//,
  /^release-notes\//,
  /^deploy\/test\//,
  /^scripts\/test\//,
  /^\.github\/(?!workflows\/checks\.yml$)/,
  // The repository's own top-level docs (README.md, AGENTS.md).
  /^[^/]+\.md$/,
]

/** The slow jobs that a change to `files` needs. */
export function areas(files) {
  if (files.length === 0 || files.some((file) => CI.includes(file))) return { deploy: true, images: true }
  return {
    deploy: files.some((file) => DEPLOY.some((pattern) => pattern.test(file))),
    images: files.some((file) => !NOT_IMAGES.some((pattern) => pattern.test(file))),
  }
}

/** The files changed from `base` to HEAD, or null when git can't say. */
export function changedFiles(base, cwd = process.cwd()) {
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { cwd, encoding: 'utf8' })
  if (diff.status !== 0) return null
  return diff.stdout.split('\0').filter(Boolean)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2]
  if (!base) {
    console.error('Usage: node scripts/ci-changes.mjs <base> | all')
    process.exit(2)
  }
  let result = { deploy: true, images: true }
  if (base !== 'all') {
    const files = changedFiles(base)
    if (files === null) console.log(`Couldn't diff ${base} with HEAD, so everything runs`)
    else result = areas(files)
  }
  const lines = Object.entries(result).map(([name, value]) => `${name}=${value}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n')
}

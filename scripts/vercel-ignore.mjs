// Vercel's Ignored Build Step for the web app (`ignoreCommand` in vercel.json). Vercel skips
// the build when this exits 0 and builds when it exits 1.
//
// It skips main, which has no Vercel site (production is a self-hosted server, deploy/), and
// any commit where git shows that none of the files the site is built from changed since the
// branch's last successful deployment. Anything it can't tell (a branch's first deployment, a
// commit missing from Vercel's shallow clone, a CLI deploy such as `pnpm preview`) builds.
import { spawnSync } from 'node:child_process'
import { environments, root } from './lib.mjs'

// Everything nightly's build reads: the web app, and the backend it deploys. Keep this in step
// with the imports that reach outside apps/desktop and with "Which commits deploy" in
// docs/CONTRIBUTING.md. .gitignore matters too: Tailwind skips the files it lists.
const paths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.vercelignore',
  '.gitignore',
  '.gitattributes',
  'vercel.json',
  'apps/desktop',
  'packages',
  'scripts/vercel-build.mjs',
  'scripts/lib.mjs',
]

const build = (reason) => {
  console.log(`Building: ${reason}`)
  process.exit(1)
}
const skip = (reason) => {
  console.log(`Skipping: ${reason}`)
  process.exit(0)
}
const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })

const { VERCEL_ENV, VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: current, TRIODITIS_PREVIEW } = process.env
if (TRIODITIS_PREVIEW) build('a `pnpm preview` deployment')
if (VERCEL_ENV === 'production' && !environments.production)
  skip('main has no Vercel site; production is self-hosted (deploy/).')
if (!current) build('not a Git deployment')
if (!previous) build('the first deployment of this branch')
if (git('cat-file', '-e', `${previous}^{commit}`).status !== 0) {
  build(`the last deployed commit, ${previous.slice(0, 7)}, is not in Vercel's clone`)
}
const diff = git('diff', '--name-only', previous, current, '--', ...paths)
if (diff.status !== 0) build(`git could not compare ${previous.slice(0, 7)} with ${current.slice(0, 7)}`)
const changed = diff.stdout.trim()
if (changed) build(`these changed since ${previous.slice(0, 7)}\n${changed}`)
skip(`nothing the site is built from changed since ${previous.slice(0, 7)}.`)

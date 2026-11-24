// Vercel's Ignored Build Step for each Vercel project, set as `ignoreCommand` in its vercel.json
// so the dashboard holds no copy of its own:
//
//   node ../../scripts/vercel-ignore.mjs site   trioditis-site: trioditis.app (apps/site/vercel.json)
//   node ../../scripts/vercel-ignore.mjs docs   trioditis-docs: docs.trioditis.app (apps/docs/vercel.json)
//   node scripts/vercel-ignore.mjs web          the web app (the root vercel.json), once its project exists
//
// Vercel skips the build when this exits 0 and builds when it exits 1. Any other exit code fails
// the deployment, so every path out of here is 0 or 1, a thrown error included. Node can still end
// another way (killed, or not found), so each vercel.json wraps the call in
// `if …; then exit 0; else exit 1; fi`, which turns anything but a clean skip into a build. It skips only when git
// shows that none of the files the site is built from changed since the branch's last successful
// deployment. Anything it can't tell builds: a branch's first deployment, a last deployed commit
// that has fallen out of Vercel's shallow clone, a CLI deploy such as `pnpm preview`.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Every site's files depend on these: .vercelignore decides what Vercel uploads, and
// .gitattributes how git checks files out (line endings, for one).
const checkout = ['.vercelignore', '.gitattributes']
// The install reads these, for a site that installs dependencies.
const install = [...checkout, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']

// Everything each site's build reads. Keep these in step with what each build reaches outside
// its own folder for, and with "The websites" in apps/docs/src/content/docs/contributing/workflow.md.
export const sites = {
  // Plain files with no build: only the folder itself, and what Vercel uploads of it.
  site: [...checkout, 'apps/site'],
  docs: [...install, 'apps/docs'],
  // Nightly's build: the web app, and the backend it deploys. .gitignore matters too: Tailwind
  // skips the files it lists.
  web: [
    ...install,
    '.gitignore',
    'vercel.json',
    'apps/desktop',
    'packages',
    'scripts/vercel-build.mjs',
    'scripts/lib.mjs',
  ],
}

/**
 * Whether Vercel should build `site` for the deployment `env` describes, from the git checkout
 * at `cwd`. Returns `{ build, reason }`.
 */
export function decide(site, env, cwd = root) {
  const build = (reason) => ({ build: true, reason })
  const paths = sites[site]
  if (!paths) return build(`no site called ${JSON.stringify(site)}; expected one of ${Object.keys(sites).join(', ')}`)

  const { VERCEL_ENV, VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: current, TRIODITIS_PREVIEW } = env
  if (TRIODITIS_PREVIEW) return build('a `pnpm preview` deployment')
  // The web app's production is a self-hosted server (deploy/), not Vercel. The site and the
  // docs have production on Vercel, from dev.
  if (site === 'web' && VERCEL_ENV === 'production') {
    return { build: false, reason: 'main has no Vercel site; production is self-hosted (deploy/).' }
  }
  if (!current) return build('not a Git deployment')
  if (!previous) return build('the first deployment of this branch')
  if (!/^[0-9a-f]{7,64}$/i.test(previous) || !/^[0-9a-f]{7,64}$/i.test(current)) {
    return build(`Vercel gave commits git can't look up: ${previous} and ${current}`)
  }

  const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  // Vercel clones only the last few commits, and the previous SHA is the last *successful*
  // deployment's, which skipped commits don't move. So after enough skips it isn't here.
  if (git('cat-file', '-e', `${previous}^{commit}`).status !== 0) {
    return build(`the last deployed commit, ${previous.slice(0, 7)}, is not in Vercel's clone`)
  }
  const diff = git('diff', '--name-only', previous, current, '--', ...paths)
  if (diff.status !== 0) return build(`git could not compare ${previous.slice(0, 7)} with ${current.slice(0, 7)}`)
  const changed = diff.stdout.trim()
  if (changed) return build(`these changed since ${previous.slice(0, 7)}\n${changed}`)
  return { build: false, reason: `nothing the ${site} site is built from changed since ${previous.slice(0, 7)}.` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result
  try {
    result = decide(process.argv[2], process.env)
  } catch (error) {
    result = { build: true, reason: `the check itself failed: ${error?.stack ?? error}` }
  }
  console.log(`${result.build ? 'Building' : 'Skipping'}: ${result.reason}`)
  process.exit(result.build ? 1 : 0)
}

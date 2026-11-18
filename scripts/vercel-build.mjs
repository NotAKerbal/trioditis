// The build command Vercel runs for the web app (set in vercel.json).
//
//   dev   → nightly, a demo-only instance on the `nightly` Convex deployment
//   main  → nothing yet: Trioditis's production is a self-hosted server (deploy/), and
//           vercel-ignore.mjs skips main until a Vercel production site is set up
//
// For nightly it deploys the Convex functions with the CONVEX_DEPLOY_KEY that Vercel holds
// for the `dev` branch, builds the web app against that backend, and loads the demo data. A
// build started by `pnpm preview` is given its backend already and only builds the web app.
//
// Either way it writes Vercel's Build Output (.vercel/output): the app's static files, and
// routes that send sign-in (/api/auth), the MCP server and its OAuth discovery documents to
// the backend, so the browser signs in on the site's own address, and every other path to the
// app's index.html.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLOUD_NETWORKS,
  DESKTOP_PACKAGE,
  TESTER,
  backendDir,
  capture,
  desktopDir,
  ensureTester,
  environments,
  root,
  run,
  step,
  x25519,
} from './lib.mjs'
import { randomBytes } from 'node:crypto'
import { seedDemo } from './demo.mjs'

const fail = (message) => {
  console.error(`\n\x1b[1m${message}\x1b[0m`)
  process.exit(1)
}

/** The routes in front of the app: the backend's paths, then files, then the app itself. */
export function writeBuildOutput(convexSiteUrl) {
  const output = resolve(root, '.vercel/output')
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  cpSync(resolve(desktopDir, 'dist'), resolve(output, 'static'), { recursive: true })
  const backend = convexSiteUrl.replace(/\/$/, '')
  writeFileSync(
    resolve(output, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [
          { src: '^/api/auth(/.*)?$', dest: `${backend}/api/auth$1` },
          { src: '^/mcp(/.*)?$', dest: `${backend}/mcp$1` },
          {
            src: '^/\\.well-known/(oauth-protected-resource|oauth-authorization-server)(/.*)?$',
            dest: `${backend}/.well-known/$1$2`,
          },
          { handle: 'filesystem' },
          { src: '/.*', dest: '/index.html' },
        ],
      },
      null,
      2,
    ),
  )
}

const { VERCEL_ENV, VERCEL_GIT_COMMIT_REF, VERCEL_GIT_COMMIT_SHA, CONVEX_DEPLOY_KEY, TRIODITIS_PREVIEW } = process.env
const name = TRIODITIS_PREVIEW ? null : VERCEL_ENV === 'preview' && VERCEL_GIT_COMMIT_REF === 'dev' ? 'nightly' : null

if (!name) {
  // `pnpm preview` has already deployed its own backend and passes its addresses in.
  const { VITE_CONVEX_URL, VITE_CONVEX_SITE_URL } = process.env
  if (!TRIODITIS_PREVIEW || !VITE_CONVEX_URL || !VITE_CONVEX_SITE_URL) {
    fail('Nothing to build against: only dev (nightly) and `pnpm preview` deployments have a backend.')
  }
  step(`Web app: preview ${TRIODITIS_PREVIEW}`)
  run('pnpm', ['--filter', DESKTOP_PACKAGE, 'run', 'build'], { env: { VITE_TRIODITIS_ENVIRONMENT: 'preview' } })
  writeBuildOutput(VITE_CONVEX_SITE_URL)
  process.exit(0)
}

const target = environments[name]
if (!target?.deployment || !target.siteUrl) {
  fail(
    `The ${name} site isn't set up yet: fill in environments.${name} in scripts/lib.mjs (docs/CONTRIBUTING.md, "Setting it up").`,
  )
}
if (!CONVEX_DEPLOY_KEY)
  fail(`CONVEX_DEPLOY_KEY is not set for ${name}. Add the ${name} backend's deploy key to the Vercel project.`)
if (!CONVEX_DEPLOY_KEY.startsWith('prod:')) fail(`The CONVEX_DEPLOY_KEY for ${name} is not a production deploy key.`)
// A deploy key starts `prod:<deployment name>|`.
const keyDeployment = CONVEX_DEPLOY_KEY.slice('prod:'.length, CONVEX_DEPLOY_KEY.indexOf('|'))
if (keyDeployment !== target.deployment) {
  fail(`The CONVEX_DEPLOY_KEY for ${name} belongs to ${keyDeployment}, not ${target.deployment}.`)
}
const convexSiteUrl = `https://${target.deployment}.convex.site`

// With CONVEX_DEPLOY_KEY in the environment, every convex command acts on that key's backend.
const convex = (...rest) => ['exec', 'convex', ...rest]
const inBackend = { cwd: backendDir, quiet: true }

step(`Backend settings: ${name}`)
const names = capture('pnpm', convex('env', 'list', '--names-only'), inBackend).split(/\s+/)
const get = (variable) => capture('pnpm', convex('env', 'get', variable), inBackend)
const set = (variable, value) => capture('pnpm', convex('env', 'set', variable, value), inBackend)

// A key from the wrong environment would point sign-in at the wrong site, so an existing
// SITE_URL is checked, never overwritten.
if (names.includes('SITE_URL')) {
  if (get('SITE_URL') !== target.siteUrl)
    fail(`This backend's SITE_URL is not ${target.siteUrl}. Check that CONVEX_DEPLOY_KEY belongs to ${name}.`)
} else {
  set('SITE_URL', target.siteUrl)
}
// Nightly is demo-only: it never offers a real network, so no real account or message can
// reach it. No bridge host connects to it either; the gateway secret and the bridge key exist
// only because the backend expects them, and nothing outside it ever holds them.
if (names.includes('TRIODITIS_NETWORKS')) {
  if (get('TRIODITIS_NETWORKS') !== CLOUD_NETWORKS)
    fail(`TRIODITIS_NETWORKS on ${name} must be "${CLOUD_NETWORKS}": a backend on Convex's cloud is demo-only.`)
} else {
  set('TRIODITIS_NETWORKS', CLOUD_NETWORKS)
}
const secret = () => randomBytes(32).toString('base64url')
const defaults = {
  BETTER_AUTH_SECRET: secret,
  GATEWAY_SECRET: secret,
  TRIODITIS_SETUP_TOKEN: secret,
  BRIDGE_PUBLIC_KEY: () => x25519().publicKey,
  AGENT_ACCESS_PUBLIC_KEY: () => x25519().publicKey,
}
for (const [variable, make] of Object.entries(defaults)) {
  if (!names.includes(variable)) {
    set(variable, make())
    console.log(`Created ${variable}.`)
  }
}

// `--cmd` builds the web app with VITE_CONVEX_URL set to this backend. Nightly is a Vercel
// preview build that deploys to a production Convex deployment on purpose; `convex deploy`
// refuses that unless its build environment check is turned off, which is done only after the
// key and SITE_URL checks above.
step(`Backend and web app: deploying ${name}`)
run(
  'pnpm',
  [
    ...convex('deploy', '--yes', '--check-build-environment', 'disable'),
    '--cmd',
    `pnpm --filter ${DESKTOP_PACKAGE} run build`,
    '--cmd-url-env-var-name',
    'VITE_CONVEX_URL',
    '--message',
    `Vercel ${name} build of ${VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown commit'}`,
  ],
  { cwd: backendDir, env: { VITE_CONVEX_SITE_URL: convexSiteUrl, VITE_TRIODITIS_ENVIRONMENT: name } },
)
writeBuildOutput(convexSiteUrl)

step(`Demo data: ${name}`)
const userId = await ensureTester({
  authUrl: convexSiteUrl,
  origin: target.siteUrl,
  setupToken: get('TRIODITIS_SETUP_TOKEN'),
})
await seedDemo((fn, args) => capture('pnpm', convex('run', fn, JSON.stringify(args)), inBackend), userId)
console.log(`Sign in at ${target.siteUrl} as ${TESTER.email}.`)

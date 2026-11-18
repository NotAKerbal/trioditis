# Contributing

## Set up

You need Node 24 or newer and pnpm 12 (`corepack enable` picks the pinned pnpm). The bridge
host is Go, so `pnpm dev`, `pnpm check` and the bridge host's tests also need Go 1.27; the
scripts find it on `PATH` or in `~/.local/go`. Docker is not needed for development: the
backend runs on Convex's local backend, on your machine, with no Convex account.

```sh
git clone https://github.com/NotAKerbal/trioditis.git
cd trioditis
pnpm install
```

The repository is a pnpm workspace. Apps live in `apps/`, shared packages in `packages/`.
Always install from the root, and always with pnpm.

## Commands

Run these from the repository root.

| Command                                | What it does                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`                             | A working local instance of this checkout, with its own backend, gateway and fake network |
| `pnpm dev --network whatsapp`          | The same with a real WhatsApp bridge host (`fake,whatsapp` for both)                      |
| `pnpm dev --setup`                     | Sets that instance up and stops; run it for every new worktree                            |
| `pnpm fake <username> <from> "<text>"` | Delivers a message on the fake network to the running instance                            |
| `pnpm preview`                         | Deploys your working tree as a demo instance on a public URL, with its own backend        |
| `pnpm check`                           | Runs exactly what CI runs: typecheck, lint, tests, and the bridge host's Go vet and tests |
| `pnpm typecheck`                       | Type-checks every TypeScript package                                                      |
| `pnpm test`                            | Runs the TypeScript tests; no services needed                                             |
| `pnpm lint`                            | Lints the TypeScript and JavaScript with oxlint                                           |
| `pnpm build`                           | Builds every package that has a build                                                     |

## Running locally

```sh
pnpm dev
```

This one command:

1. Creates a Convex backend for this checkout the first time. It is a local deployment that
   needs no account, and its data lives in `packages/backend/.convex/local`, which git ignores.
2. Generates this checkout's secrets and key pairs once, into `.data/dev.env` (readable only
   by you), and sets the ones the backend needs on it: `SITE_URL`, `BETTER_AUTH_SECRET`,
   `GATEWAY_SECRET`, `TRIODITIS_SETUP_TOKEN`, `TRIODITIS_NETWORKS`, `BRIDGE_PUBLIC_KEY` and
   `AGENT_ACCESS_PUBLIC_KEY`.
3. Builds the bridge host.
4. Starts the backend in watch mode and creates the test account, as the server's admin.
5. Starts the gateway, a bridge host for each network (the fake network unless you pass
   `--network`), and the web app from `apps/desktop` once that exists.

Each process's output is prefixed with its name. When everything is up it prints the URL and
the test account, `tester@trioditis.test` / `trioditis-dev-tester`. Ctrl+C stops everything.

Sign in to the web app at the address it prints, `http://localhost:<port>`. The web app's dev
server forwards sign-in (`/api/auth`) and the MCP server to the backend, so the browser signs
in on the page's own address, as it does behind Caddy and on Vercel; `SITE_URL` on the backend
is that address. Without `apps/desktop`, `SITE_URL` is the backend's own HTTP address, which
tools and scripts call directly.

### The fake network

The fake network is a network that doesn't exist: it logs in with any username and does what
it's told. Connect it from the app (or the end-to-end script) with a username, then deliver
messages to it:

```sh
pnpm fake isaac alice "hello"                 # a direct message from alice
pnpm fake isaac alice "hi all" --chat family  # into a group chat
```

Use `pnpm dev --network whatsapp` to bridge a real WhatsApp account instead. Its data stays on
this machine, in this checkout's `.data/`.

### One instance per branch

Every checkout of the repository, the main one and each git worktree, gets its own backend,
data and ports, so several branches run at the same time without touching each other. A
checkout's slot is in `.data/dev.json`.

|                                    | Slot 0 (main checkout) | Slot n (a worktree)        |
| ---------------------------------- | ---------------------- | -------------------------- |
| Web app                            | `5180`                 | `5180 + n`                 |
| Backend (Convex API, HTTP actions) | `4210`, `4211`         | `4210 + 2n`, `4211 + 2n`   |
| Gateway                            | `8700`                 | `8700 + 10n`               |
| Bridge hosts (fake, WhatsApp)      | `8701`, `8702`         | `8701 + 10n`, `8702 + 10n` |
| Fake network control               | `8709`                 | `8709 + 10n`               |

A worktree claims the first free slot the first time it is set up and keeps it while it
exists, even when it isn't running. These ports stay clear of Convex's defaults, so a backend
started by hand never takes a checkout's ports.

In T3 Code, the Trioditis project should run `pnpm install && pnpm dev --setup` for every new
worktree, so a branch's instance is ready before its first change. `--setup` does the slow
part (creating the backend, building the bridge host, creating the test account) and stops,
so idle worktrees use no memory. Run `pnpm dev` when you want to use it.

### What the web app is given

`pnpm dev` runs `pnpm --filter @trioditis/desktop dev` with:

| Variable                     | Value                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `PORT`                       | This checkout's web port                                                      |
| `VITE_CONVEX_URL`            | The backend's Convex API address                                              |
| `VITE_CONVEX_SITE_URL`       | The backend's HTTP actions address, where Better Auth and the MCP server live |
| `VITE_TRIODITIS_ENVIRONMENT` | `development`                                                                 |

Previews get `preview`, nightly `nightly`, and the self-hosted bundle `selfhosted`. The web app
builds to `apps/desktop/dist`, a static single-page app.

### Starting over

To throw a checkout's data away, stop `pnpm dev` and delete `packages/backend/.convex/local`,
`packages/backend/.env.local` and `.data/`. The next `pnpm dev` starts empty, with new
secrets. Deleting only `.data/bridge-<network>` forgets that network's logins.

### Schema changes before the first release

Until the first release there is no data to keep, so schema changes don't come with
migrations. If a change no longer matches what a dev backend holds, `convex dev` refuses to
push it: start over as above. From the first release on, every schema change ships with its
migration.

### End-to-end check

With `pnpm dev` running, the end-to-end script signs in as the test account, connects the fake
network through a sealed login, receives and sends a message, and checks that nothing readable
reached the backend:

```sh
cd apps/gateway
node --env-file=../../.data/dev.env scripts/e2e-fake.ts tester@trioditis.test trioditis-dev-tester
```

## Previews

```sh
pnpm preview
```

This deploys the code in your working tree, committed or not, as a demo instance: a Convex
preview backend of its own and a Vercel preview of the web app. It prints the URL and the test
account when it finishes. `pnpm preview --dry-run` prints every step and does nothing.

**A preview is demo-only.** It offers only the fake network, runs no gateway or bridge host,
and its data is made up (`scripts/demo.mjs`), sealed for the test account exactly as real data
would be. No real account or real message ever goes to Convex's cloud.

|              |                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ |
| Name         | The current git branch, or `pnpm preview my-name`                                    |
| Test account | `tester@trioditis.test` / `trioditis-dev-tester`, the preview's admin                |
| Data         | Each name has its own backend. Running again keeps its data; `--fresh` starts empty. |
| URL          | Every run prints a new URL. Sign-in works on the newest one only.                    |
| Lifetime     | Convex removes a preview backend a few days after it is created                      |

You need to have run `npx convex login` and `npx vercel login` once. The web app deploys to
the Vercel project `trioditis-web` in `notakerbals-projects`, and the backend to the Convex
project `trioditis` in the `isaac-cochran` team (both set in `scripts/lib.mjs`; see
[Setting it up](#setting-it-up)).

How it works:

1. Creates the Convex preview deployment `isaac-cochran:trioditis:preview/<name>`, unless it
   exists (or with `--fresh`).
2. Makes a temporary deploy key, and deletes it however the script ends.
3. Sets the backend's variables: `BETTER_AUTH_SECRET`, `SITE_URL`, `TRIODITIS_NETWORKS=fake`,
   and a gateway secret, setup token and public keys that nothing outside the backend ever
   holds, since no bridge host connects to a preview.
4. Deploys the backend functions.
5. Deploys the web app to a Vercel preview, with `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and
   `TRIODITIS_PREVIEW` as build variables, and without git details, so a preview made from
   `dev`'s tip can't take over nightly's domain.
6. Points `SITE_URL` at the preview's URL, creates the test account through it, and loads the
   demo data.

On Vercel, `scripts/vercel-build.mjs` builds the web app and writes Vercel's Build Output
itself: the app's files, plus routes that send `/api/auth`, `/mcp` and the OAuth discovery
documents to the preview's backend, so sign-in happens on the site's own address, and every
other path to `index.html`.

## Nightly

A push to `dev` deploys nightly, a demo-only instance on its own Convex deployment. Nobody
deploys it by hand.

|          | Nightly                                                    |
| -------- | ---------------------------------------------------------- |
| Branch   | `dev`                                                      |
| Backend  | The `nightly` deployment in the `trioditis` Convex project |
| Networks | The fake network only; no bridge host                      |
| Data     | The demo data, for the test account                        |

There is no production site on Vercel. Trioditis's production is a server people run
themselves (`deploy/`). `main` is enabled for Git deploys so a production site can be added
later, but `scripts/vercel-ignore.mjs` skips its builds until `environments.production` is
set in `scripts/lib.mjs`.

### How a deploy works

`vercel.json` turns off Git deploys for every branch except `main` and `dev`, and replaces the
build command with `scripts/vercel-build.mjs`. For a push to `dev`, that script:

1. Reads `CONVEX_DEPLOY_KEY`, which Vercel holds for the `dev` branch, and refuses to go on if
   it is missing, not a production key, or for a deployment other than nightly's.
2. Checks the backend's variables. It sets `SITE_URL` to nightly's address the first time and
   stops the build if it holds a different one. It sets `TRIODITIS_NETWORKS=fake` the first
   time and stops the build if it holds anything else. It creates the secrets it needs if
   they're missing.
3. Runs `convex deploy`, which pushes the backend functions and builds the web app with
   `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and `VITE_TRIODITIS_ENVIRONMENT=nightly`. Nightly
   is a Vercel preview build deploying to a production Convex deployment on purpose, so it
   passes `--check-build-environment disable`.
4. Writes the Build Output, as for a preview, and creates the test account and the demo data
   if they aren't there.

If any step fails, the deployment fails and the site keeps serving the last good one.

### Which commits deploy

`scripts/vercel-ignore.mjs` is Vercel's Ignored Build Step. It builds only if one of these
changed since the branch's last successful deployment: `apps/desktop/`, `packages/`,
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.vercelignore`,
`.gitignore`, `.gitattributes`, `vercel.json`, `scripts/vercel-build.mjs`, `scripts/lib.mjs`
and `scripts/demo.mjs`. When it can't tell (a branch's first deployment, a commit missing from
Vercel's clone, a `pnpm preview` deploy), it builds. A skipped commit shows as **Canceled**.

### Setting it up

Done once, by someone with access to both accounts. Nothing here exists yet.

**Convex**, from `packages/backend`, signed in with `npx convex login`:

1. Create the project `trioditis` in the `isaac-cochran` team (Convex dashboard).
2. Create the nightly deployment and its deploy key:

   ```sh
   pnpm exec convex deployment create isaac-cochran:trioditis:nightly --type prod
   pnpm exec convex deployment token create vercel-nightly --deployment isaac-cochran:trioditis:nightly
   ```

3. Put the deployment's name (as `deployment`) and nightly's address (as `siteUrl`) in
   `environments.nightly` in `scripts/lib.mjs`.

**Vercel**, in `notakerbals-projects`:

1. Create the project `trioditis-web`, linked to `NotAKerbal/trioditis`, with the repository
   root as its root directory and the build settings from `vercel.json`.
2. Production branch: `main`. Add nightly's domain to the Preview environment, for the Git
   branch `dev`.
3. Add `CONVEX_DEPLOY_KEY` to the Preview environment **for the branch `dev` only**: the
   `vercel-nightly` key. Mark it sensitive. Never give it to all preview branches.
4. Turn off Vercel's login wall for previews, so a preview can be opened without a Vercel
   account; the app's own sign-in is the gate.
5. Put the team's ID (`vercelOrgId`) and the project's ID (`vercelWebProjectId`) in `accounts`
   in `scripts/lib.mjs`. `vercel project inspect trioditis-web` shows them.

## The self-hosted dev deployment

The instance to actually use, with real accounts, is the self-hosted bundle in `deploy/`,
running from `dev` on a server of your own. See `deploy/` for installing and updating it.

## Branches

| Branch           | Purpose                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `main`           | Released code. Only release merges from `dev` land here.                                            |
| `dev`            | Integration. Every feature branch merges here through a pull request.                               |
| `<area>/<topic>` | One branch per piece of work, from `dev`, e.g. `phase0/bridge-host`, `networks/signal`, `ui/inbox`. |

- Branch from `dev`, open the pull request against `dev`.
- Work that depends on an unmerged branch stacks on it, and its pull request targets that
  branch until it merges.
- A release is a pull request from `dev` to `main`.
- Nothing is merged without passing checks and an independent review.

## Worktrees

Each branch gets its own worktree inside the repository, under `.worktrees/` (ignored by
git), so several branches, and several agents, can work at once without touching each
other's files.

```sh
git fetch origin
git worktree add -b networks/signal .worktrees/signal origin/dev
cd .worktrees/signal
pnpm install && pnpm dev --setup
```

- One writer per worktree.
- Remove a worktree when its branch merges: `git worktree remove .worktrees/signal`.
- `pnpm install` is fast in a new worktree: pnpm's store is shared, and so are Go's module and
  build caches.

## Layout

```
apps/
  bridge-host/    Go: bridgev2 network connectors behind Trioditis's own MatrixConnector
  gateway/        Node: bridge host ↔ Convex pipeline
  desktop/        The desktop and web app (from the UI work)
packages/
  backend/        Convex: schema, functions, auth, MCP server
  core/           Shared types and the bridge protocol's wire types
  crypto/         Sealing (docs/architecture/sealing.md)
  config/         Shared TypeScript config
scripts/          pnpm dev, preview, fake and check; the Vercel build and skip steps; demo data
deploy/           The self-hosted bundle
docs/
  PLAN.md         Product and implementation plan
  architecture/   Contracts between components
vercel.json       Git deploys, the build command and the skip step for Vercel
```

## Checks

Run before opening a pull request:

```sh
pnpm check
```

It runs exactly what CI runs (`.github/workflows/checks.yml`): `pnpm typecheck`, `pnpm lint`,
`pnpm test`, and `go vet ./...` and `go test ./...` in `apps/bridge-host`, then prints each as
Passed or Failed. Use it when CI can't run, and report its results.

## Contracts

Changes to a contract in `docs/architecture/` change both sides in the same pull request,
with the shared test vectors or fixtures updated.

## Troubleshooting

- **`pnpm dev` says every slot is taken.** Another program holds the ports. `ss -ltn` shows
  which; or remove `.data/dev.json` to pick a new slot.
- **"This backend already has an admin."** The backend was set up with another account first.
  Sign in with that one, or start over.
- **`convex dev` refuses to push a schema change.** The backend holds data the new schema
  doesn't allow. Start over (see [Starting over](#starting-over)).
- **The bridge host won't build.** It needs Go 1.27 on `PATH` or in `~/.local/go`.
- **The fake network refuses a message (409).** The username must be the one you connected
  the fake network with.

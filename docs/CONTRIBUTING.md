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

| Command                     | What it does                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                  | A working local instance of this checkout, with its own backend, gateway and a WhatsApp bridge host |
| `pnpm dev --network signal` | The same with another network's bridge host (`whatsapp,signal` for both)                            |
| `pnpm dev --demo`           | The same with no network: demo chats only, like a preview                                           |
| `pnpm dev --setup`          | Sets that instance up and stops; run it for every new worktree                                      |
| `pnpm preview`              | Deploys your working tree as a demo instance on a public URL, with its own backend                  |
| `pnpm check`                | Runs exactly what CI runs: typecheck, lint, tests, and the bridge host's Go vet and tests           |
| `pnpm typecheck`            | Type-checks every TypeScript package                                                                |
| `pnpm test`                 | Runs the TypeScript tests; no services needed                                                       |
| `pnpm lint`                 | Lints the TypeScript and JavaScript with oxlint                                                     |
| `pnpm build`                | Builds every package that has a build                                                               |

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
3. Builds the bridge host and the sign-in browser's launcher.
4. Starts the backend in watch mode and creates the test account, as the server's admin.
5. Starts the gateway, the sign-in browser if it finds a Chromium, a bridge host for each
   network (WhatsApp unless you pass `--network`), and the web app from `apps/desktop` once
   that exists.

Each process's output is prefixed with its name. When everything is up it prints the URL and
the test account, `tester@trioditis.test` / `trioditis-dev-tester`. Ctrl+C stops everything.
Like the app, the account signs in with the password derived from that one (`authPassword` in
packages/crypto). A test account made before sign-in derived its password is moved to the
derived one the next time `pnpm dev` runs, so there is no need to start over.

Sign in to the web app at the address it prints, `http://localhost:<port>`. The web app's dev
server forwards sign-in (`/api/auth`) and the MCP server to the backend, so the browser signs
in on the page's own address, as it does behind Caddy and on Vercel; `SITE_URL` on the backend
is that address. Without `apps/desktop`, `SITE_URL` is the backend's own HTTP address, which
tools and scripts call directly.

### Networks

`TRIODITIS_NETWORKS` is the networks this instance runs a bridge host for: the ones an admin
can install in the app (Admin settings → Networks). The test account is the admin, so install
the network there, then connect your account to it. `pnpm dev` bridges WhatsApp, which links
with your phone; `--network` picks others, comma-separated. A network's data stays on this
machine, in this checkout's `.data/`. Signal's bridge host links libsignal, so the first run
with Signal builds it (Rust, several minutes).

The networks that log in on their website (Messenger, Instagram, Google Messages, Google
Voice, Slack, LinkedIn, X) sign in through the sign-in browser
(docs/architecture/signin-browser.md). `pnpm dev` runs it with `CHROMIUM_PATH`, or the first
of `chromium`, `chromium-browser`, `google-chrome-stable` and `google-chrome` on your `PATH`,
keeping each browser's profile in `/dev/shm`. Without one it says so, and those logins ask
for their cookies to be pasted instead. Its launcher and the gateway's public listener, which
the web app's dev server forwards `/login-browser` to, take two more of the checkout's ports.

### Demo data

```sh
pnpm dev --demo
```

This runs no gateway and no bridge host, and sets `TRIODITIS_DEMO=1` on the backend with no
`TRIODITIS_NETWORKS`, as a preview does. The backend then makes demo data for an account that
asks for it (`demo.seedForMe`, from the app's settings), sealed to that account's own key, and
turns invitations off. Demo chats show on real networks' badges, though nothing is bridged.
The next `pnpm dev` without `--demo` removes `TRIODITIS_DEMO` again; the demo chats stay until
you start over.

### One instance per branch

Every checkout of the repository, the main one and each git worktree, gets its own backend,
data and ports, so several branches run at the same time without touching each other. A
checkout's slot is in `.data/dev.json`, and it holds the slot in a registry every checkout on
the machine shares, `~/.local/state/trioditis/slots/<n>.lock`, which names the checkout. A lock
is created only if it doesn't exist, so two worktrees setting up at once never get the same
slot.

|                                    | Slot 0 (main checkout) | Slot n (a worktree)      |
| ---------------------------------- | ---------------------- | ------------------------ |
| Web app                            | `5180`                 | `5180 + n`               |
| Backend (Convex API, HTTP actions) | `4210`, `4211`         | `4210 + 2n`, `4211 + 2n` |
| Gateway                            | `8700`                 | `8700 + 10n`             |
| Bridge host (WhatsApp)             | `8702`                 | `8702 + 10n`             |

A worktree claims the first free slot the first time it is set up and keeps it while it
exists, even when it isn't running. On every start the saved slot is checked against the
registry; a slot whose lock names another checkout is given up for a new one, and a lock whose
checkout no longer exists is released. Releasing happens under a guard,
`~/.local/state/trioditis/slots/releasing/<n>.lock`, so two checkouts starting at once can't
release the lock one of them has just taken. A guard is held for an instant; if a run is killed
in that instant, its guard stays and that slot isn't released until you delete the guard (the
next run says so). These ports stay clear of Convex's defaults, so a backend started by hand
never takes a checkout's ports.

Only one `pnpm dev` (with or without `--setup` or `--reset`) runs at a time for a checkout: each
holds `.data/dev.lock` while it runs, and a second one stops and says which process holds it.
A lock left by a run that was killed is taken over, under its own guard,
`.data/releasing/dev.lock`.

A guard is never removed automatically: two runs both clearing a leftover guard could let
two releases happen at once again. If one is left, the run that finds it stops (for
`.data/dev.lock`) or warns and takes another slot (for a slot), and names the guard file.
Check that no `pnpm dev` for that checkout is running, delete the file it names, and run
again.

In T3 Code, the Trioditis project should run `pnpm install && pnpm dev --setup` for every new
worktree, so a branch's instance is ready before its first change. `--setup` does the slow
part (creating the backend, building the bridge host, creating the test account) and stops,
so idle worktrees use no memory. Run `pnpm dev` when you want to use it.

### Only this checkout's backend

`pnpm dev` never acts on any backend but this checkout's own local one:

- Every Convex command it runs has the variables that choose a deployment removed from its
  environment (`CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SELF_HOSTED_URL`,
  `CONVEX_SELF_HOSTED_ADMIN_KEY` and every other `CONVEX_` variable), so a key in your shell
  can't send its pushes anywhere.
- The Convex CLI also loads `packages/backend/.env.local` and `packages/backend/.env`, and a
  deploy key in either overrides `CONVEX_DEPLOYMENT`. So before it runs any Convex command,
  `pnpm dev` reads both files the way the CLI's dotenv does (`export` prefixes, quotes,
  comments) and refuses any `CONVEX_` variable in them, except what the CLI writes to
  `.env.local` for this checkout's local deployment: `CONVEX_DEPLOYMENT` naming the one in
  `packages/backend/.convex/local`, and `CONVEX_URL` and `CONVEX_SITE_URL` on this machine. A
  dotenv vault (`.env.vault`, `.env.local.vault`) is refused too.
- Until `packages/backend/.convex/local` holds this checkout's backend, the CLI looks for the
  deployment it is about to use in `~/.convex/anonymous-convex-backend-state`, where older
  versions kept backends for every project, and would push to it. So then `.env.local` may name
  no deployment, and `pnpm dev` refuses if `~/.convex/anonymous-convex-backend-state/anonymous-agent`
  (the name a new one gets) exists: move it aside.
- Before it writes anything, and again before Convex commands, it refuses if anything it or
  the Convex CLI writes in the checkout is a symlink or leads outside it: `.data` and
  everything in it (secrets, the slot, the run lock, bridge logins), everything in
  `packages/backend/.convex`, `packages/backend/.env.local` and `.gitignore`, and the
  generated code in `packages/backend/convex/_generated` and
  `packages/backend/convex/betterAuth/_generated`. So a database, settings or secrets
  elsewhere are never changed through a link. Its own writes refuse a link at the file or
  directory itself, even one made after the check: files are written to a new file beside
  them and renamed into place, directories are opened with `O_NOFOLLOW` before their mode is
  set, and locks are created with `O_EXCL`. That protects only the last part of the path: a
  directory above it replaced by a link in between would still be followed. The Convex CLI's
  own writes are protected only by the check just before each Convex command; a link created
  after that check isn't caught.
- If any of these fails, it stops and says why. For a reported symlink, replace it with a
  real file or directory in the checkout (move the data it pointed to back in, or delete it
  and let setup make a new one), then run again.
- Settings are passed to Convex through stdin, not as arguments, so secrets don't show up in
  a process list, and the settings already there are read without being printed.
  `packages/backend/.convex` and `.data/` are readable only by you, from when they are created.

The gateway and the bridge hosts listen on `127.0.0.1` only,
and the web app does unless you set `HOST`. The local backend listens on all of the machine's
network interfaces: the Convex CLI has no option to bind it to `127.0.0.1`. Its admin API needs
the admin key in `.convex`, but its HTTP actions (sign-in) can be reached from your network.
Use a firewall on a shared network.

The gateway is restarted when its code, or `packages/core` or `packages/crypto`, changes, and
after a crash; if it stops three times in a minute, `pnpm dev` stops everything and says so.
If the gateway or the web app doesn't answer in time, `pnpm dev` says which and stops
everything.

### What the web app is given

`pnpm dev` runs `pnpm --filter @trioditis/desktop dev` with:

| Variable                     | Value                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | This checkout's web port                                                                                                |
| `VITE_CONVEX_URL`            | The backend's Convex API address                                                                                        |
| `VITE_CONVEX_SITE_URL`       | The backend's HTTP actions address, where Better Auth and the MCP server live                                           |
| `VITE_TRIODITIS_ENVIRONMENT` | `development`                                                                                                           |
| `HOST`                       | Passed through from your shell. When set, the dev server listens on every interface, for another device on your network |

Previews get `preview`, nightly `nightly`, and the self-hosted bundle `selfhosted`. The web app
builds to `apps/desktop/dist`, a static single-page app.

### The desktop app

The desktop app is an Electron window onto a server's own web app: the same pages a browser
gets, with native notifications, a dock badge for unread chats and an app menu. It ships no
copy of the web app, so it is always the version the server runs, and sign-in, cookies and
passkeys stay first-party on the server's address. Its code is in `apps/desktop/electron`.

```sh
pnpm --filter @trioditis/desktop app                                     # asks for a server
pnpm --filter @trioditis/desktop app --server http://localhost:<port>    # this checkout's, not saved
```

The first run downloads Electron's binary (pnpm doesn't run its install script). The app asks
for the address you open Trioditis at, checks that it is a Trioditis server whose web app
works in the desktop app (its `trioditis-desktop` marker; a server from before it is turned
away as too old), and remembers it; **File → Change Server…**, or **Change** beside the
server's name on the sign-in page, picks another. Plain `http://` is accepted only for this
machine. Each server gets its own session, so nothing is shared between them.

What the server's page can do is limited: it runs sandboxed with no Node, stays on the
server's address (other links open in your browser), may ask only for notifications, the
clipboard and full screen, and reaches the app only to set the badge, bring the window
forward and open the server picker, each checked in the main process. Opening the picker
changes nothing by itself: the person still types the address, and the picker checks it.

Notifications follow `messages.arrivals` (client-api.md, Arrivals). They are on by default in
the desktop app; a browser asks first (Settings → Notifications). They show who sent the
message (the chat's name; a group's own name, until member names exist) and what it says,
never the network. The system can keep them in its notification history, outside the
sealing: a deliberate exception (AGENTS.md).

On Ubuntu, Chromium's sandbox refuses to start from `node_modules`, because `chrome-sandbox` isn't owned
by root there; for local testing pass `--no-sandbox` after `app`. Installers that set this up
properly are not built yet.

On a Mac and on Linux, passkeys don't work in the desktop app: Electron reaches the Mac's own
(iCloud Keychain) only from a signed app tied to the server's domain, which a self-hosted
server can't be, and it can't ask a security key for the PIN that signing in, unlocking and
adding a passkey all require. On Windows the system asks, so they work. Sign-in, unlock and
Settings → Keys and devices say so; use the password or recovery key in the app, or the
passkey in a browser.

Unsent drafts live only in the page's memory, so reloading, closing the window or changing
servers with one open asks first.

### Starting over

To throw a checkout's data away, stop `pnpm dev` and run `pnpm dev --setup --reset`. It
deletes this checkout's backend (`packages/backend/.convex/local` and `.env.local`) and the
bridge hosts' logins (`.data/bridge-<network>`), then sets up again with a new test account.
It keeps `.data/dev.json`, which holds this checkout's slot and ports, and the secrets in
`.data/`. Deleting only `.data/bridge-<network>` forgets that network's logins.

A reset refuses while this checkout's `pnpm dev` runs, and while any backend is using this
checkout's data, on any port: something listening on the ports in
`.convex/local/default/config.json`, or a process using `packages/backend/.convex/local`
(one you started by hand with `npx convex dev`, say). On Linux that means:

- a process with a file there open, running in a directory there, or naming a path there in
  its arguments, relative paths read from its working directory;
- a Convex local backend running anywhere in this checkout (not in another checkout inside
  it), since it opens its data relative to its directory by default;
- a Convex local backend whose open files and directory can't be read (another user's), unless
  it runs in a container. What such a backend opens can't be told from its arguments, so it
  counts as using this checkout's data. A container's backend is ignored, recognised by its
  cgroup (Docker, containerd, Podman, Kubernetes, LXC).

The reset can't see into containers. A container whose Convex backend uses this checkout's
files through a bind mount, such as a dev container with the checkout mounted, isn't
detected, and a reset would delete the database from under it: stop such containers before
`pnpm dev --setup --reset`. The self-hosted bundle (`deploy/`) is safe to leave running: it
keeps its data in named Docker volumes and mounts no checkout.

On other systems only absolute paths in a process's arguments are checked, so a backend
started there with relative paths isn't seen. Only a process's ID and program are shown,
never its arguments, which include the backend's instance secret.

When a reset names a process, stop that backend (Ctrl+C where it runs, or end the process it
names) and run the reset again. If it names another user's backend you are certain has
nothing to do with this checkout, run `pnpm dev --setup --reset --reset-ignoring <pid>` with
the ID it gave; repeat the option for several. It skips only those processes, and only when
they can't be inspected: one seen using this checkout's data still stops the reset.

A reset deletes nothing a symlink leads to outside the checkout. `--reset` on its own is
refused.

Don't delete all of `.data/`: the next run would claim the slot again, but you'd lose the
secrets the backend was set up with. If you did, `pnpm dev --setup --reset` starts cleanly.

### Schema changes before the first release

Until the first release there is no data to keep, so schema changes don't come with
migrations. If a change no longer matches what a dev backend holds, `convex dev` refuses to
push it: start over as above. From the first release on, every schema change ships with its
migration.

For example, chats now must have a `view` and reactions a `chatId`, which rows written by
`dev` before the client API (b61b99b) don't have: a backend holding those must start over
before it takes this schema.

One-off fixes for rows an older version wrote are internal functions in
`packages/backend/convex/migrations.ts`, each safe to run any number of times, and
`migrations:runAll` runs them all in order: add a new one there too. `pnpm dev` (and
`--setup`) calls `runAll` once its functions are pushed, directly on this checkout's backend
with its own admin key, so a backend that keeps its data is always caught up; after adding a
migration while `pnpm dev` runs, restart it. `runAll` waits for each migration's first
batch; a migration that goes on in further scheduled batches finishes in the background, so
a later batch's failure shows in the backend's logs rather than stopping setup. The self-hosted installer calls it after each of
its deploys as well: see `docs/deploy.md`.

## Previews

```sh
pnpm preview
```

This deploys the code in your working tree, committed or not, as a demo instance: a Convex
preview backend of its own and a Vercel preview of the web app. It prints the URL and the test
account when it finishes. `pnpm preview --dry-run` prints every step and does nothing.

**A preview is demo-only.** It has no networks: every run removes `TRIODITIS_NETWORKS` and sets
`TRIODITIS_DEMO=1`. The backend then refuses every network's events and refuses invitations,
so the test account can't invite anyone. It runs no gateway or bridge host, and its data is
made up by the backend (`demo.seedForMe`, with `TRIODITIS_DEMO=1`), sealed to the test
account's own key exactly as real data would be. Its demo chats show on real networks'
badges, though nothing is bridged. No real account or real message ever goes to Convex's
cloud.

Previews are short-lived and per branch, so each gets the known test account. It signs in with
the password the app derives from `trioditis-dev-tester` (`authPassword` in packages/crypto),
not the typed one, and its key is set up the way the app's first device does it, with the
recovery key printed at the end.

Before it creates or changes anything on either service, `pnpm preview` checks everything it
needs and lists what's missing: the Vercel project's IDs in `scripts/lib.mjs`, the web app
(`@trioditis/desktop` with a build script), and the client API from `api/client-contract`:
packages/crypto's `authPassword`, `generateKeyPair` and `makeKeySetup`, and the backend's
`keys.setup`, `keys.identity` and `demo.seedForMe`. `--dry-run` shows the same list, then the
steps.

|              |                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Name         | The current git branch, or `pnpm preview my-name`                                                |
| Test account | `tester@trioditis.test` / `trioditis-dev-tester`, the preview's admin                            |
| Data         | Each name has its own backend. Running again keeps its data and secrets; `--fresh` starts empty. |
| Runs         | One at a time per name: a second `pnpm preview <name>` stops until the first has finished.       |
| URL          | Every run prints a new URL. Sign-in works on the newest one only.                                |
| Lifetime     | Convex removes a preview backend a few days after it is created                                  |

You need to have run `npx convex login` and `npx vercel login` once. The web app deploys to
the Vercel project `trioditis-web` in `notakerbals-projects`, and the backend to the Convex
project `trioditis` in the `isaac-cochran` team (both set in `scripts/lib.mjs`; see
[Setting it up](#setting-it-up)).

How it works:

1. Creates the Convex preview deployment `isaac-cochran:trioditis:preview/<name>`, unless it
   exists (or with `--fresh`).
2. Makes a temporary deploy key, and deletes it however the script ends.
3. Sets the backend's variables that are missing: `BETTER_AUTH_SECRET`, `SITE_URL`, and a
   gateway secret, setup token and public keys that nothing outside the backend ever
   holds, since no bridge host connects to a preview. `TRIODITIS_DEMO=1` is set and
   `TRIODITIS_NETWORKS` removed on every run, whatever the backend held before.
4. Deploys the backend functions.
5. Deploys the web app to a Vercel preview, with `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and
   `TRIODITIS_PREVIEW` as build variables, and without git details, so a preview made from
   `dev`'s tip can't take over nightly's domain.
6. Points `SITE_URL` at the preview's URL, creates the test account through it, sets up its
   key (`makeKeySetup`, then `keys.setup`), and asks the backend for its demo data
   (`demo.seedForMe`) as that account.

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
| Networks | None; no bridge host                                       |
| Accounts | One: the first admin, who signs up with the setup link     |
| Data     | Demo data for whoever signs up, sealed to their own key    |

**Nightly gets no test account, ever.** Its first admin signs up with the setup link,
`<nightly>/setup?token=<token>`. `TRIODITIS_DEMO=1` turns invitations off, so that is the only
account nightly has. The deploy that creates the token
prints the link in its Vercel build log, once; after that, get the token with:

```sh
cd packages/backend && npx convex env get TRIODITIS_SETUP_TOKEN --deployment isaac-cochran:trioditis:nightly
```

Nightly sets `TRIODITIS_DEMO=1` and has no `TRIODITIS_NETWORKS` on every deploy: the backend
refuses every network's events and refuses invitations, and the admin gets demo data from the
backend (`demo.seedForMe`), sealed to their own key, on real networks' badges. No known
password is involved.

There is no production site on Vercel. Trioditis's production is a server people run
themselves (`deploy/`). Only `dev` deploys from Git; `vercel.json` turns `main` off, and
`scripts/vercel-ignore.mjs` skips it too in case it is ever turned back on.

### How a deploy works

`vercel.json` turns off Git deploys for every branch except `dev`, and replaces the build
command with `scripts/vercel-build.mjs`. For a push to `dev`, that script:

1. Checks everything before changing anything, and lists what's missing: `environments.nightly`
   in `scripts/lib.mjs`, the web app and its build script, the backend's `demo.seedForMe`, and
   `CONVEX_DEPLOY_KEY`, which Vercel holds for the `dev` branch and must be a production key
   for nightly's deployment.
2. Checks the backend's variables. It sets `SITE_URL` to nightly's address the first time and
   stops the build if it holds a different one. It removes `TRIODITIS_NETWORKS` if it's set (a
   backend on Convex's cloud has no networks), and sets `TRIODITIS_DEMO=1`. It creates
   the secrets it needs if they're missing (through stdin, never in the build log), and creates
   `TRIODITIS_SETUP_TOKEN` once, printing the setup link on that run only.
3. Runs `convex deploy`, which pushes the backend functions and builds the web app with
   `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and `VITE_TRIODITIS_ENVIRONMENT=nightly`. Nightly
   is a Vercel preview build deploying to a production Convex deployment on purpose, so it
   passes `--check-build-environment disable`.
4. Writes the Build Output, as for a preview. It creates no account.

If any step fails, the deployment fails and the site keeps serving the last good one. The
backend functions are pushed before the web app is built, so a failed web build can leave the
backend one version ahead of the site until the next good deploy.

The Build Output's routes send `/api/auth`, `/mcp`, and the discovery documents
(`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` and
`/.well-known/openid-configuration`) to the backend; every other path that isn't a file gets
`index.html`.

### Which commits deploy

`scripts/vercel-ignore.mjs` is Vercel's Ignored Build Step. It builds only if one of these
changed since the branch's last successful deployment: `apps/desktop/`, `packages/`,
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.vercelignore`,
`.gitignore`, `.gitattributes`, `vercel.json`, `scripts/vercel-build.mjs` and
`scripts/lib.mjs`. When it can't tell (a branch's first deployment, a commit missing from
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

Git deploys are limited to `dev` by `vercel.json`.

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
- Every pull request adds a release note (below).
- Nothing is merged without passing checks and an independent review.

## Release notes

Every pull request adds a file to `release-notes/` saying what it changes, written by whoever
makes the change, agent or person. Admins read them in the app before and after an update
(Admin settings → Updates): the updater collects the notes an update adds, and the app groups
them by label.

```
New: React to a message from the button beside Reply.
Fixed: Signing in to Google no longer freezes when the page asks for a passkey.
```

- Name the file after the change, in lowercase letters, digits and dashes:
  `release-notes/message-reactions.md`.
- Each line is one change, starting with its label: `New:`, `Improved:`, `Fixed:`,
  `Security:` or `Internal:`. One to eight lines, each at most 200 characters, with no tabs.
- Write for the people using the server: what they can now do, or what no longer goes wrong.
  `Internal:` is for changes they won't notice (CI, refactors, docs), so every pull request
  still has a note.
- Add a new file every time. The updater shows the lines an update adds, word for word, so a
  note renamed or moved isn't shown again, and an edited line shows as new.

`node scripts/release-notes.mjs check` checks the format (it's part of `pnpm check`), and CI
fails a pull request that adds no new line. Review judges whether the note says what changed.

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
  desktop/        The web app, and the desktop app's Electron shell in electron/
packages/
  backend/        Convex: schema, functions, auth, MCP server
  core/           Shared types and the bridge protocol's wire types
  crypto/         Sealing (docs/architecture/sealing.md)
  config/         Shared TypeScript config
scripts/          pnpm dev, preview and check; the Vercel build and skip steps; the preview test account
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
`pnpm test`, `pnpm test:scripts`, `node scripts/release-notes.mjs check`, `go vet ./...`, `go vet -tags libsignal ./...` and `go test ./...` in `apps/bridge-host`,
and `node scripts/signal-fork.mjs check` (the bridge host's patched copy of mautrix-signal is
upstream plus its patch; `apps/bridge-host/third_party/README.md`), then prints each as Passed
or Failed. Use it when CI can't run, and report its results. CI also checks that a pull
request adds a release note, which `pnpm check` can't do without the pull request's base.

`pnpm lint` also checks the design system's rules in `apps/desktop` and `packages/ui`
(`scripts/lint/design-system.mjs`, after Flux's):

| Rule                          | Where                     | What it asks                                                                                                                           |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `trioditis/no-literal-colour` | the app and `packages/ui` | No hex, `rgb()`, `hsl()` or other colour literals in class names or styles: use the tokens (`packages/ui/src/styles/tokens.css`)       |
| `trioditis/no-raw-control`    | the app                   | No one-off `<button>`, `<input>`, `<select>` or `<textarea>`: use packages/ui's, or wrap one in a packages/ui component with `asChild` |
| `trioditis/ui-imports`        | the app                   | Import packages/ui one component at a time, as `@trioditis/ui/button`: there is no index, and no reaching into its files               |

Turn one off only for a line, with a reason:
`// eslint-disable-next-line trioditis/no-raw-control -- why packages/ui has nothing that fits`.

## Contracts

Changes to a contract in `docs/architecture/` change both sides in the same pull request,
with the shared test vectors or fixtures updated.

## Troubleshooting

- **`pnpm dev` says every slot is taken.** Other programs hold the ports. `ss -ltn` shows
  which. A checkout keeps its slot even if `.data/dev.json` is deleted; removing a worktree
  frees its slot.
- **"This backend already has an admin who isn't the test account."** The backend was set up
  with another account first. Sign in with that one, or `pnpm dev --setup --reset` (see
  [Starting over](#starting-over)). A test account from before sign-in derived its password is
  moved over by itself.
- **`convex dev` refuses to push a schema change.** The backend holds data the new schema
  doesn't allow. Start over (see [Starting over](#starting-over)).
- **"pnpm dev only works with this checkout's own local backend."** `packages/backend` points
  at another backend (a `CONVEX_DEPLOYMENT` in `.env.local` that isn't `anonymous:…`, or a
  `CONVEX_` variable in another dotenv file). Move those files aside, or start over.
- **"Another run holds preview-<name>."** A `pnpm preview` with that name is still running.
- **The bridge host won't build.** It needs Go 1.27 on `PATH` or in `~/.local/go`.

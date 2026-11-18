# Contributing

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
pnpm install
```

- One writer per worktree.
- Remove a worktree when its branch merges: `git worktree remove .worktrees/signal`.
- `pnpm install` is fast in a new worktree: pnpm's store is shared.
- Go's module and build caches are shared too.

## Layout

```
apps/
  bridge-host/    Go: bridgev2 network connectors behind Trioditis's own MatrixConnector
  gateway/        Node: bridge host ↔ Convex pipeline
packages/
  backend/        Convex: schema, functions, auth, MCP server
  core/           Shared types and the bridge protocol's wire types
  crypto/         Sealing (docs/architecture/sealing.md)
  config/         Shared TypeScript config
docs/
  PLAN.md         Product and implementation plan
  architecture/   Contracts between components
```

The desktop and mobile apps (`apps/desktop`, `apps/mobile`) are added by the UI work.

## Toolchain

- Node 24 and pnpm 12 (`corepack enable` picks the pinned pnpm).
- Go 1.27 for `apps/bridge-host`.
- No Docker needed for development: the backend runs on Convex's local backend.

## Run the stack locally

```sh
pnpm install
# 1. The backend, on Convex's local backend (no account, no Docker). Leave it running.
CONVEX_AGENT_MODE=anonymous pnpm --filter @trioditis/backend dev
# 2. Once, in another terminal: secrets and key pairs into .data/dev.env, and onto Convex.
CONVEX_AGENT_MODE=anonymous pnpm dev:setup
# 3. The gateway.
pnpm --filter @trioditis/gateway dev
# 4. A bridge host: see apps/bridge-host/README.md.
```

### End-to-end check with the fake network

With the backend and gateway running, start a fake-network bridge host with its dev
control endpoint, then run the end-to-end script as the dev admin (created with the setup
token):

```sh
cd apps/bridge-host && go build -o bin/bridge-host ./cmd/bridge-host
set -a; . ../../.data/dev.env; set +a
BRIDGE_HOST_ADDR=127.0.0.1:8611 BRIDGE_FAKE_CONTROL_ADDR=127.0.0.1:8621 \
  BRIDGE_DATA_DIR=../../.data/bridge-fake ./bin/bridge-host --network fake run
# in another terminal
cd apps/gateway && node --env-file=../../.data/dev.env scripts/e2e-fake.ts <email> <password>
```

It connects the fake network through a sealed login, receives and sends a message, and
checks that nothing readable reached Convex.

`.data/` holds the dev stack's secrets and runtime data. It is git-ignored; never commit
it.

## Checks

Run before opening a pull request:

```sh
pnpm typecheck
pnpm lint
pnpm test
(cd apps/bridge-host && go vet ./... && go test ./...)
```

CI runs the same on every pull request.

## Contracts

Changes to a contract in `docs/architecture/` change both sides in the same pull
request, with the shared test vectors or fixtures updated.

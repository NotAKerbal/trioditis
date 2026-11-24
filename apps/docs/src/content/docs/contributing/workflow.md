---
title: Workflow & Checks
description: Branching model, git worktrees, CI checks, design system rules, release notes, and cross-language contract rules.
---

## Branching model

| Branch           | Purpose                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `main`           | Released code (`Stable` updater channel). Updated only via release pull requests from `dev`.          |
| `dev`            | Integration branch (`Nightly` updater channel). All feature and fix PRs branch from and target `dev`. |
| `<area>/<topic>` | Feature or fix branches (for example `networks/signal`, `ui/inbox`, `docs/starlight`).                |

- Never commit directly to `main` or `dev`.
- Stack dependent work on its prerequisite branch and target that branch until it merges.
- Every pull request requires passing checks and an independent review.

## Working in git worktrees

Give each branch its own worktree under `.worktrees/` (gitignored) so multiple branches can run simultaneously:

```sh
git fetch origin
git worktree add -b networks/signal .worktrees/signal origin/dev
cd .worktrees/signal
pnpm install && pnpm dev --setup
```

Remove the worktree once its PR merges:

```sh
git worktree remove .worktrees/signal
```

## Pre-PR checks

Run the full check suite from the repository root before opening a pull request:

```sh
pnpm check
```

`pnpm check` runs what every pull request runs in `.github/workflows/checks.yml`:

1. `pnpm typecheck`
2. `pnpm lint` (`oxlint` with type-aware checks, Convex plugin rules, and design system rules)
3. `pnpm format:check` (Prettier; `pnpm format` fixes it)
4. `pnpm test` (Vitest across all TypeScript packages and `convex-test`)
5. `pnpm test:scripts` (Node test runner for `scripts/`)
6. `pnpm build` (the web app and the docs site)
7. The release notes' format
8. `go vet ./...` and `go test ./...` inside `apps/bridge-host`, and the patched mautrix copies

Astro, which the docs site's typecheck and build run, needs a CPU with AVX. On a machine without it, such as some virtual machines, `pnpm check` reports those two steps as **Blocked** and leaves them to CI. It still exits non-zero then, so read its summary: a Blocked docs step there isn't a failure of the branch.

### What CI runs

CI runs automatically on every pull request, on every push to `dev` and `main`, and nightly on `dev`. It can also be started by hand from the **Actions** tab (**Checks → Run workflow**).

| Job           | What it checks                                                                                                             | When                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| TypeScript    | Steps 1–7 of `pnpm check` above, and that the pull request adds a release note                                             | Always                                                                        |
| Bridge host   | `go vet`, `go vet -tags libsignal`, `go test`, and the patched mautrix copies                                              | Always                                                                        |
| Deploy bundle | `deploy/test/run.sh` against throwaway Compose projects (about eight minutes). Run it locally with `pnpm check --deploy`   | When a pull request changes `deploy/`; always otherwise                       |
| Image (×4)    | Builds the web, Node, sign-in browser and bridge host (with Signal) images every server builds when it installs or updates | When a pull request changes anything an image is built from; always otherwise |
| All checks    | Passes only when every job above passed or was skipped as not needed                                                       | Always                                                                        |

`scripts/ci-changes.mjs` decides which of the two slow jobs a pull request needs. A pull request that changes only docs, the site, release notes or tests skips the images. Pushes to `dev` and `main` always run both, so a skip never lets a broken bundle reach a server unseen. **All checks** is the one check to require before merging. The nightly run builds the images from scratch, so a break in what nothing pins, such as Debian's packages, shows up even on a day no pull request touches them.

The [load test](/contributing/load-test/) (`pnpm load-test`) isn't part of `pnpm check`. It takes about half an hour and runs nightly. Run it for a change to backend queries, ingestion or what the desktop subscribes to.

### Design system lint rules

`pnpm lint` enforces three custom rules (`scripts/lint/design-system.mjs`) in `apps/desktop` and `packages/ui`:

| Rule                          | Scope                         | Requirement                                                                                            |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `trioditis/no-literal-colour` | `apps/desktop`, `packages/ui` | No hex, `rgb()`, or `hsl()` literals—always use design tokens from `packages/ui/src/styles/tokens.css` |
| `trioditis/no-raw-control`    | `apps/desktop`                | Use `@trioditis/ui` primitives instead of raw `<button>`, `<input>`, `<select>`, or `<textarea>`       |
| `trioditis/ui-imports`        | `apps/desktop`                | Import one component at a time (e.g. `@trioditis/ui/button`)                                           |

Only disable a rule for a single line with an inline explanation:
`// eslint-disable-next-line trioditis/no-raw-control -- reason`

## Keeping contracts in sync

- **TypeScript ↔ Go:** Any change to the [Sealed Storage Spec](/security/sealing/) or [Bridge Protocol](/architecture/bridge-protocol/) must update **both** TypeScript (`packages/crypto`, `packages/core`, `packages/backend`, `apps/gateway`) and Go (`apps/bridge-host`) in the same pull request, including shared test vectors.
- **Bridge events:** change the `bridgeEvent` validator, then run `pnpm --filter @trioditis/backend protocol-schema` and commit what it writes. The bridge host reads each event type's fields from it ([Bridge Protocol](/architecture/bridge-protocol/#one-schema-for-both-sides)).
- **No plaintext leaks:** Never write plaintext message bodies, chat names, or contact names to Convex, logs, or unencrypted disk.
- **No auto-retry after ambiguity:** Always surface the `unknown` delivery state rather than silently resending.
- **Release notes:** User-visible changes add a short note under `release-notes/`, which the server updater surfaces in **Settings → Admin → Updates**.

## Desktop releases

A desktop release is tagged on a release merge commit on `main` (which matches what servers on the **Stable** update channel run):

```sh
git fetch origin && git tag v0.1.0 origin/main
git push origin v0.1.0
```

Pushing a `v<version>` tag triggers `.github/workflows/desktop-release.yml`, building native installers on macOS (Apple Silicon and Intel, ad-hoc signed), Windows (`x64`), and Linux (`AppImage` and `.deb`) and publishing them with SHA-256 checksums to GitHub Releases. Pre-release tags (such as `v0.2.0-beta.1`) publish as GitHub prereleases without moving the `releases/latest` download links. Note that `electron-builder.yml` packages only the Electron shell and server picker—the web app comes directly from your Trioditis server.

## Repository layout

```
apps/
  bridge-host/    Go: bridgev2 MatrixConnector, 12 connectors, sealing, journal, login-browser
  desktop/        Web & Electron desktop app (Vite + TanStack Router/Query)
  docs/           Astro Starlight documentation site (all project docs live in src/content/docs/)
  gateway/        Node: bridge host ↔ Convex pipeline & sign-in browser proxy
  site/           Project landing page
assets/
  brand/          Generated brand SVGs, PNGs, favicon, and social card
packages/
  backend/        Convex schema, queries, mutations, Better Auth, MCP server
  brand/          Brand asset generator (pnpm --filter @trioditis/brand generate)
  config/         Shared TypeScript configuration
  core/           Shared domain types and bridge protocol wire types
  crypto/         Sealed storage, key wrapping, Argon2id password derivation
  ui/             Design tokens, Wordmark, and UI component primitives
deploy/
  compose/        Docker Compose bundle, Caddyfile, network overlays
  docker/         Pinned Dockerfiles (web, node, bridge-host, login-browser)
  install/        install.sh and proxmox.sh
  scripts/        Key generation, encrypted backups, admin CLI, migrations, updater agent
  test/           Automated deployment bundle test suite
release-notes/    Per-change release notes shown by the updater
scripts/          Dev stack and CI check runner
```

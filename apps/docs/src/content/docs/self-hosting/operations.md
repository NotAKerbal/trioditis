---
title: Operations & Auto-Updates
description: Manage services, inspect routing, configure in-app automatic updates with rollback, and run manual upgrades.
---

## Running services

A Trioditis server runs the following Docker Compose services on internal Docker networks, with **only Caddy exposed**:

| Service            | Purpose                                                                                    | Network exposure                     |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| `caddy`            | Serves the web app and reverse-proxies API, auth, MCP, and sign-in browser traffic         | **Public** (the only published port) |
| `hairpin`          | Added behind a reverse proxy on the same machine when needed for JWKS reachability         | Docker host address only             |
| `loopback`         | Added in loopback mode (`--host 127.0.0.1`) so the backend reaches Caddy                   | Internal only                        |
| `backend`          | Self-hosted Convex backend backed by PostgreSQL                                            | Internal only                        |
| `postgres`         | PostgreSQL 17 holding Convex's database and each bridge host's schema                      | Internal only                        |
| `functions`        | One-shot job: syncs Convex env vars, deploys functions, and runs migrations                | Internal only                        |
| `gateway`          | Moves sealed events and commands between bridge hosts and Convex; proxies `/login-browser` | Internal only                        |
| `bridge-<network>` | Dedicated bridge host process for each enabled messaging network                           | Internal only                        |
| `login-browser`    | Isolated Chromium launcher for website-authenticated network logins                        | `signin` internal network only       |

## Using `deploy/trioditis`

`deploy/trioditis` wraps `docker compose` with the install's saved project name, compose files, and `deploy/.env`. It refuses Compose flags before the subcommand (`-p`, `-f`, `--env-file`, `--profile`) so commands always act on the exact installed configuration.

```sh
deploy/trioditis ps
deploy/trioditis logs -f gateway
deploy/trioditis restart bridge-whatsapp
deploy/trioditis down          # Stop services; data stays in Docker volumes
deploy/trioditis up -d         # Start services again
```

:::note[Operation lock]
The installer, `backup`, `restore`, `create-admin`, `keys import`, the updater, and any mutating Compose subcommand acquire a lock in `deploy/` so two state-changing operations never collide. Read-only commands (`ps`, `logs`, `config`, `top`, `images`, `ls`, `port`, `version`, `events`) can run alongside them. `config` prints to the terminal only and refuses `-o`/`--output`.
:::

## HTTP routing

Caddy serves everything from a single origin so Better Auth cookies and WebAuthn passkeys remain first-party:

| Path                                     | Upstream                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `/convex/*`                              | Convex client API & WebSocket sync (port `3210`, prefix stripped)                  |
| `/api/auth/*`                            | Better Auth HTTP routes on Convex HTTP actions (port `3211`)                       |
| `/mcp`, `/mcp/*`, `/.well-known/oauth-*` | MCP server & OAuth 2.1 discovery on Convex HTTP actions                            |
| `/login-browser`                         | Isolated sign-in browser WebSocket via the gateway's public listener (port `8602`) |
| `/config.json`                           | Runtime client config written by the installer (`Cache-Control: no-store`)         |
| Everything else                          | Static web app (`apps/desktop`), falling back to `index.html`                      |

Caddy also listens on `127.0.0.1:8090` inside its container solely for Docker health checks.

## Automatic updates

Trioditis includes a systemd updater service (`trioditis-updater-<project>`), enabled by default on systemd hosts, so admins can manage updates directly from **Admin settings → Updates**:

- **Channels:** **Stable** (`main`, default) or **Nightly** (`dev`). While running a pre-release install from `dev`, switch to **Nightly** so the updater tracks new changes.
- **Schedule:** Toggle **Automatic updates** (off by default) to install updates nightly during the 4 AM host local hour, or trigger **Check now** / **Update now** on demand.
- **Release notes:** Displays curated release notes (`release-notes/`) for pending and recently installed updates.
- **Built before it stops:** The updater first builds the new version's images while the server keeps running (from a temporary checkout of the new commit, tagged `prebuild` until the update is over). A version that doesn't build is called off with the server still running, and the installer's own build afterwards comes from Docker's cache, so the server is only down for the backup and the restart. The build competes with the running server for CPU for a few minutes, so a small machine may answer slowly meanwhile.
- **Safe rollback:** Before updating, the updater takes an encrypted backup (`deploy/trioditis backup --keep-stopped`, keeping the 3 newest snapshots in `UPDATE_BACKUP_DIR` or `~/.local/state/trioditis/<project>/updater-backups`). If the installer or migrations fail, it automatically checks out the previous commit and restores the pre-update backup.
- **Forward-only:** Updates only fast-forward along the selected channel's branch and refuse checkouts with modified tracked files.

Inspect updater logs or toggle the service:

```sh
journalctl --user -u trioditis-updater-trioditis   # Omit --user if installed as root
deploy/install/install.sh --no-updater             # Disable updater (manual upgrades only)
deploy/install/install.sh --updater                # Re-enable updater
```

:::tip[User-service lingering]
When installed as a non-root user, enable systemd lingering (`loginctl enable-linger <user>`) so the updater continues running after you sign out of SSH.
:::

## Manual upgrades

If you prefer updating by hand (`--no-updater`), take a backup first, then pull and rerun the installer:

```sh
deploy/trioditis backup ~/trioditis-backups
git pull --ff-only
deploy/install/install.sh
```

Rerunning `install.sh` keeps every secret and saved option in `deploy/.env`, rebuilds changed images, deploys Convex functions, and runs all idempotent migrations via `migrations:runAll`. Database schema migrations only move forward—downgrading always requires restoring a backup from the earlier version. Open browser tabs detect new builds via `/version.json` and reload automatically when idle (or prompt if you have an unsaved draft).

## Running a second throwaway instance

To run an isolated test instance on the same host without touching your main install, clone into a separate directory and set `TRIODITIS_PROJECT` on the first run:

```sh
TRIODITIS_PROJECT=trioditis-test deploy/install/install.sh \
  --host 127.0.0.1 --bind 127.0.0.1 --port 18080
```

`TRIODITIS_PROJECT` applies only to brand-new installs; existing installs stay pinned to their saved project name. Tear down a throwaway install with `deploy/trioditis down -v`.

## Bundle test suite

`deploy/test/` validates encrypted backups, restore, key handling, updater safety, operation locks, port isolation, and Caddy IP headers against throwaway Compose projects without touching any live server:

```sh
deploy/test/run.sh                    # Full suite (~5 minutes)
deploy/test/backup-publish.sh         # Or run a single test
```

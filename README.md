<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup-dark.svg">
    <img src="assets/brand/lockup.svg" height="56" alt="Trioditis">
  </picture>
</h1>

_"Of the three roads": a crossroads for all of your conversations._

Trioditis is an open-source, self-hosted universal messaging hub: one fast, cohesive app for
WhatsApp, Signal, Google Messages, Google Voice, Telegram, Messenger, Instagram, Slack, GroupMe,
LinkedIn, X, and Bluesky, running on a server you own. Host an instance for yourself or your
household and invite the people you message with—stored messages, attachments, chat names, and
contacts are sealed to each person's own keys.

**[trioditis.app](https://trioditis.app)** · **[Documentation](https://docs.trioditis.app)**

**Status:** active pre-release development on `dev`. The core stack (Go bridge host with 12
network connectors, isolated Chromium sign-in browser, Node gateway, self-hosted Convex backend on
PostgreSQL, sealed storage crypto, desktop & web app, auto-updater, encrypted backup & restore,
and Docker Compose / Proxmox installer) is built and running.

## Highlights

- **Your server, your data:** Bridges and message storage run on hardware you control, with no
  third-party bridge cloud in the message path.
- **Sealed by default:** Stored content is encrypted with per-object content keys sealed to each
  member's X25519 identity key. The server operator can run and back up the instance without
  reading anyone's history.
- **No Matrix homeserver:** A custom Go bridge host implements `mautrix` `bridgev2`'s
  `MatrixConnector` directly for full-history backfill, simpler operations, and earliest-possible
  sealing.
- **Honest delivery:** Sends are never silently retried after an ambiguous outcome—Trioditis
  surfaces an explicit `unknown` state so you choose whether to resend or discard.
- **AI agents on a leash:** Connect external MCP agents (including planned first-class support
  for Dots and Grok Bot) with OAuth 2.1, per-chat grants, human-in-the-loop approval cards, and
  an append-only audit log.

## Quick start

### Self-host with Docker Compose

Requires Docker Engine 28+ with the Compose plugin, Git, and 8 GiB free disk space:

```sh
git clone --branch dev https://github.com/NotAKerbal/trioditis.git
cd trioditis
deploy/install/install.sh --domain chat.example.com
```

See the [Self-Hosting guides](https://docs.trioditis.app/self-hosting/installation/) for
Tailscale Serve, reverse proxies, Proxmox VE (`deploy/install/proxmox.sh`), auto-updates,
encrypted backups, and key management.

### Develop locally

Requires Node.js 24+, pnpm 12, and Go 1.27 (no Docker or Convex cloud account needed):

```sh
pnpm install
pnpm dev
```

See [Local Development](https://docs.trioditis.app/contributing/local-development/) and
[Workflow & Checks](https://docs.trioditis.app/contributing/workflow/) for per-worktree
isolation, `--demo` mode, network bridge options, and CI checks (`pnpm check`).

### Documentation site

All project documentation lives in [`apps/docs/src/content/docs/`](apps/docs/src/content/docs)
and publishes to **[docs.trioditis.app](https://docs.trioditis.app)**:

```sh
pnpm docs:dev
```

## Documentation

- **[Getting Started](https://docs.trioditis.app/getting-started/introduction/)** — Overview, principles, and quickstart
- **[Self-Hosting](https://docs.trioditis.app/self-hosting/installation/)** — Installation modes, Proxmox, auto-updates, backups & restore
- **[Networks](https://docs.trioditis.app/networks/)** — Per-network guides, implementation status, and known limits for all 12 networks
- **[Security & Sealed Storage](https://docs.trioditis.app/security/overview/)** — Threat model and Sealing v1 cryptographic spec
- **[Architecture](https://docs.trioditis.app/architecture/overview/)** — System overview, Bridge Protocol v1, Client API, Sign-in Browser, Bridge Host internals
- **[Contributing & Brand](https://docs.trioditis.app/contributing/local-development/)** — Local dev, checks, Brand Guide, and Roadmap

## License

Trioditis is licensed under the [AGPL-3.0](LICENSE).

It depends on the self-hosted [Convex](https://github.com/get-convex/convex-backend) backend,
which is source-available under FSL-1.1-Apache-2.0 (converting to Apache-2.0 after two years)
and runs unmodified as a separate service.

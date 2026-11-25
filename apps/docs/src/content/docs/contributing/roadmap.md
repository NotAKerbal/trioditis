---
title: Roadmap & Decisions
description: Phased implementation plan, acceptance criteria, architecture decisions, and open engineering questions.
---

Trioditis is built in clear phases, each gated by explicit acceptance criteria rather than rough estimates.

## Implementation phases

### Phase 0 — Foundations & bridge host spike

- Monorepo (`pnpm` + Turborepo), Go bridge host module, and CI checks.
- Self-hosted Docker Compose stack: Caddy, Convex on PostgreSQL, gateway, and bridge host with WhatsApp.
- Better Auth on Convex: admin setup, invitations, passkeys, and rate limits.
- Homeserver-free `MatrixConnector` with `BatchSend` history backfill, durable journal, and sealed storage.
- `@convex-dev/mcp` verified on self-hosted Convex and continuous canary ledger for gap/duplicate detection.

### Phase 1a — WhatsApp daily driver (desktop & web)

- Full inbox and conversation UI: chat list, message view, composer, replies, edits, deletes, reactions, media, receipts, typing, unread, pin, archive, mute, snooze, labels.
- Complete outbox lifecycle with honest `unknown` delivery handling.
- Full sealed storage UX: device approval, recovery key, encrypted local SQLite cache, and on-device FTS5 search.
- Online encrypted backups, `trioditis restore` (holding pending sends for confirmation + reconciliation), and fast-lane connector updates.
- Bridge health dashboard and admin panel.

### Phase 1b — Connector platform & core networks

- Capability manifests, generic login stepper, and automated + live conformance suites.
- **Signal** and **Google Messages (SMS/RCS)** to `stable`.
- Full daily-driver feature set: starting new chats/groups, voice notes, link previews, stickers/GIFs, mention autocomplete, message requests, synced drafts, per-chat notification settings, desktop notifications, and command palette.

### Phase 2 — Mobile & push notifications

- Expo (React Native) client sharing `packages/core` and `packages/crypto`, with encrypted local cache and on-device search.
- Project-hosted push relay delivering content-free generic notifications via APNs/FCM, plus UnifiedPush/ntfy for Android without Google services.
- Mobile pairing-code logins and interactive approval cards from notifications.
- Target latency: p50 under 3 seconds, p95 under 10 seconds on real iOS and Android devices.

### Phase 3 — Additional networks

- **Telegram**, **Messenger**, and **Instagram** to `beta`; **Discord** to `experimental` once upstream `bridgev2` lands.
- Clear ToS-risk warnings before connecting cookie- or token-based networks.

### Phase 4 — AI agents (MCP)

- Built-in `Agents` network in the inbox with OAuth 2.1 consent (`/agents/connect`).
- Per-chat and per-network grants with sealed content-key re-wrapping, payload-hashed approval cards, optional per-chat auto-send rules (off by default), allowlisted signed webhooks, rate limits, global kill switch, and append-only audit log.
- First-class integrations planned for **Dots** and **Grok Bot** (alongside any standard MCP agent).

### Phase 5 — Public release

- Polished one-command installer, Proxmox VE helper, published docs site, and production push relay.
- Multi-arch (`x86_64` / `arm64`) signed images, versioned releases, desktop auto-updates, and mobile store builds.
- Target: a newcomer installs Trioditis on a fresh host, invites a second person, and links WhatsApp in under 15 minutes.

## Architecture decisions log

| #   | Decision                                                                                           | Status  |
| --- | -------------------------------------------------------------------------------------------------- | ------- |
| 1   | Open-source, self-hosted, multi-user server; anyone can host and invite members                    | Decided |
| 2   | `mautrix` `bridgev2` network connectors as the protocol layer                                      | Decided |
| 3   | Custom Go bridge host implementing `MatrixConnector` directly (no Matrix homeserver)               | Decided |
| 4   | Self-hosted Convex on PostgreSQL as the realtime backend                                           | Decided |
| 5   | Better Auth for people; `@convex-dev/mcp` for agent OAuth 2.1                                      | Decided |
| 6   | Vite + TanStack (web/desktop) + Expo (mobile) sharing core & crypto, native UI per platform        | Decided |
| 7   | Sealed storage by default using per-object random content keys sealed to each recipient            | Decided |
| 8   | Platform encryption terminates at the operator's bridge host; re-encrypted outbound per platform   | Decided |
| 9   | Separate accounts and logins per member; admin panel manages enabled networks and invites          | Decided |
| 10  | All networks carry maturity labels and pass the connector conformance suite                        | Decided |
| 11  | Never auto-resend after an ambiguous outcome; surface `unknown` delivery state                     | Decided |
| 12  | Public domain (ACME) or Tailscale Serve HTTPS; content-free push relay for mobile                  | Decided |
| 13  | Backup, restore, and update tooling as first-class operations from Phase 1                         | Decided |
| 14  | AGPL-3.0 license; self-hosted Convex backend (FSL-1.1-Apache-2.0) documented as a separate service | Decided |
| 15  | `pnpm` workspaces + Turborepo for TypeScript; Go modules for `apps/bridge-host`                    | Decided |

## Open questions

- **Connector state at rest (Phase 1):** Upgrading from encrypted-disk protection to column-level server-key sealing (or upstream pruning) for connector metadata tables.
- **Key recovery UX:** Refining device approval, recovery key entry, and passkey PRF fallback on mobile.
- **On-device search at scale:** Measuring SQLite FTS5 index size and query latency across multi-year message histories on phones.
- **Bridge host topology:** Evaluating one process per network (current) vs. one per user per network for stronger tenant isolation.
- **Discord:** Tracking or contributing to upstream's `bridgev2` migration.
- **Later features:** Cross-network contact merging and scheduled message expansion.

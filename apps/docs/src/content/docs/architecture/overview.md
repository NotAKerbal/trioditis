---
title: System Overview
description: How Trioditis connects messaging networks, seals data, delivers reliably, and integrates AI agents without a Matrix homeserver.
---

Trioditis combines `mautrix` `bridgev2` network connectors in Go, a lightweight Node gateway, a self-hosted Convex backend on PostgreSQL, and native-feeling clients—all fronted by Caddy on a single origin.

```
WhatsApp · Signal · Google Messages · Telegram · Messenger · Instagram · Discord · …
        │   (each platform's own transport and encryption)
  ┌─────────────────────────────────────────────┐
  │ Bridge host (Go)                            │
  │  mautrix bridgev2 network connectors        │
  │  + Trioditis MatrixConnector (no homeserver)│──► encrypted media store
  │  seals each message to its owner's key      │
  └──────────────┬──────────────────────────────┘
                 │ internal HTTP API (events out, commands in)
           Gateway (Node/TS) ──► self-hosted Convex (Postgres) ◄── Better Auth
                 │                   ▲          ▲
   media proxy, webhooks,            │          └── MCP server + OAuth (@convex-dev/mcp)
   login stepper                     │                      ▲
                                     │              external AI agents
                 Desktop (Electron + TanStack) · Web · Mobile (Expo)
```

## Core components

| Component              | Technology                                               | Role                                                                                                                      |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Network connectors** | `mautrix` bridgev2 connectors (Go)                       | Speak each messaging platform's protocol                                                                                  |
| **Bridge host**        | Go (`apps/bridge-host`)                                  | Implements bridgev2's `MatrixConnector` directly with no homeserver; seals incoming events; manages full-history backfill |
| **Gateway**            | Node / TypeScript (`apps/gateway`)                       | Moves sealed events and outbox commands between bridge hosts and Convex; handles login steps and media                    |
| **Backend & storage**  | Self-hosted Convex on PostgreSQL (`packages/backend`)    | Realtime subscriptions, inbox state, sealed envelopes, auth, rate limits, and MCP server                                  |
| **People auth**        | Better Auth (Convex integration)                         | Invite-only accounts, sessions, passkeys, and 2FA                                                                         |
| **Agent auth**         | `@convex-dev/mcp`                                        | Stateless MCP server with OAuth 2.1 consent, per-chat grants, and approvals                                               |
| **Desktop & web**      | Vite + TanStack Router/Query + Electron (`apps/desktop`) | Primary client; same build serves as the self-hosted web app                                                              |
| **Mobile (planned)**   | Expo (React Native) + Expo Router                        | Dedicated phone client sharing `packages/core` and `packages/crypto`                                                      |
| **Edge**               | Caddy                                                    | Automatic HTTPS and single-origin routing; the only public service                                                        |

Convex runs on **PostgreSQL** rather than its default SQLite backend to avoid out-of-memory failures on large index scans (`convex-backend#495`).

## Why no Matrix homeserver?

`mautrix` bridges cleanly separate the platform side (`NetworkConnector`) from the Matrix side (`MatrixConnector` in `bridgev2`, MPL-2.0). Instead of running Synapse as an intermediary, Trioditis implements `MatrixConnector` directly inside `apps/bridge-host`:

- **Full history backfill:** `MatrixCapabilities.BatchSending` (`BatchSend`) lets connectors import history beyond link-time sync without standard homeserver room-backfill restrictions.
- **Simpler operations:** No Synapse, no second database, no appservice registration, and no double-puppeting setup—the bridge host natively recognizes a member's own messages.
- **Deterministic deduplication:** Each remote message part hashes to a stable `eventId` used as the deduplication key end-to-end.
- **Earliest possible sealing:** Incoming messages are sealed to their owner's identity key inside the bridge host before hitting the journal, gateway, or database.
- **Process isolation:** One Go binary is compiled with all connectors and launched as one process per network (`--network <slug>`), so a crashing connector cannot bring down other networks.

## Reliability model

### Ingest (network → Convex)

1. The bridge host appends sealed events to a gap-free, sequence-numbered journal in PostgreSQL and delivers them in order to the gateway.
2. The gateway commits events to Convex using check-then-insert deduplication on `eventId` and `seq`, acknowledging only after commit.
3. Unmappable events are quarantined with a fixed reason code (never plaintext) so one bad event cannot stall a chat or feed.
4. Messages order by network timestamp (`networkTs`) plus a stable tie-breaker (`sortKey`), never arrival time. Backfilled messages carry `historical: true` so they never trigger notifications, unread bumps, or inbox reordering.

### Outbound (Convex → network)

1. Clients write sends with a client-generated `clientMessageId` and two sealed copies: one for the bridge host (`outbound`) and one for the member's own history (`message`).
2. The gateway claims outbox rows FIFO per chat using leases.
3. Delivery states progress cleanly: `queued → claimed → submitted → sent → delivered → read`, plus `failed` and `unknown`.
4. **Never auto-retry after ambiguity:** If confirmation is lost or a crash occurs mid-send, Trioditis marks the message `unknown` and asks the person whether to retry (risking a duplicate) or discard.
5. Sends undelivered after 24 hours expire cleanly so stale messages don't fire unexpectedly days later.

## Clients & code sharing

Rule of thumb: **write logic once; write screens natively per platform.**

| Layer                                      | Shared?       | Location                                  |
| ------------------------------------------ | ------------- | ----------------------------------------- |
| Convex schema, queries, mutations          | Fully         | `packages/backend`                        |
| Types, network metadata, state logic       | Fully         | `packages/core`                           |
| Sealing, key wrapping, password derivation | Fully         | `packages/crypto`                         |
| UI primitives & design tokens              | Web / Desktop | `packages/ui`                             |
| Screens, navigation, gestures, composers   | Per platform  | `apps/desktop` (and future `apps/mobile`) |

## AI agents over MCP

External AI agents (including planned first-class support for **Dots** and **Grok Bot**, alongside any MCP-capable agent) run as separate services and connect to Trioditis through `@convex-dev/mcp` (targeting stateless MCP with OAuth 2.1):

- **Agents as conversations:** A built-in `Agents` network puts each connected agent in your inbox like any other thread, where it can send briefs or **Approve / Edit / Reject** cards.
- **Zero access by default:** OAuth scopes (`read`, `draft`, `send`, `channels`) are gated by explicit per-chat or per-network grants owned by the member.
- **Cryptographic enforcement:** Granting read access re-seals that chat's content keys to the server's agent-access key; revoking removes access immediately.
- **Bound approvals & audit log:** Every outbound send approval hashes the exact payload, recipient, and attachments and expires automatically. Every MCP call, grant change, and agent-sent message is recorded in an append-only audit log.

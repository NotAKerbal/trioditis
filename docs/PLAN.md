# Trioditis — Product & Implementation Plan

*Trioditis: "of the three roads." A crossroads for all of your conversations.*

Status: draft v1, 2026-11-17. This document records the decisions made so far, the
implementation plan, and the questions still open. Update it as decisions change.

## Vision

An open-source, self-hostable alternative to Beeper: one polished app for every
messaging network you use, running on hardware you own. Beeper-level polish is the
bar. Setup is one command.

The initial audience is one household (owner + family). The longer-term goal is a
project other people self-host on their own hardware. A hosted sign-up offering is
possible later but is not a goal now.

## Principles

1. **Your hardware, your data.** Bridges and message storage run on the owner's
   server. Nothing in the message path depends on a third-party cloud.
2. **Reliability over features.** A message that arrives late or not at all is the
   worst bug. Bridge health is visible, never hidden.
3. **Simple to run.** One command on any Linux box, Proxmox host, VM, or VPS.
   Portable across x86_64 and arm64.
4. **Native-feeling everywhere.** Desktop feels like a desktop app; mobile feels like
   a mobile app. Shared logic, platform-appropriate UI.
5. **Instant by default.** The app opens to your chats immediately, from a local
   cache, before the network answers.
6. **Agents are first-class, and on a leash.** Agents appear as conversations, act
   through a documented API, and do only what the owner allows.

## Architecture

```
WhatsApp · Signal · Google Messages · Telegram · Discord · Instagram/Messenger
        │   (each platform's own transport and encryption)
  mautrix bridges ──► Synapse (+ Postgres)                ← internal only, never exposed
        │                    │ appservice transactions
        │              sync service ──► self-hosted Convex ◄── Better Auth
        │                                   ▲     ▲
        │          MCP server + webhooks ───┘     │
        │          ▲                              │
  external agents (Dots, Grokbot, …)              │
                                   Desktop (Electron + TanStack) · Web · Mobile (Expo)
```

| Component | Choice | Role |
|---|---|---|
| Network bridges | mautrix bridges (Go, bridgev2) | Speak each platform's protocol |
| Homeserver | Synapse + Postgres, federation disabled | Hosts the bridges; internal network only |
| Sync service | TypeScript (Node) | Mirrors Matrix events into Convex; executes outbound actions; drives bridge logins |
| Backend / data | Self-hosted Convex | Realtime data for every client: inbox, messages, agents, settings |
| Auth | Better Auth (Convex integration) | App accounts, sessions, agent OAuth for MCP |
| Desktop / web | Electron + Vite + TanStack Router/Query (SPA) | Primary client; same build also served as a web app |
| Mobile | Expo (React Native) + Expo Router | Phone client |
| Push | Project-run push gateway | Content-free wake-up pings via APNs/FCM; UnifiedPush option |
| Edge | Caddy | Automatic HTTPS; the only publicly exposed service |

Convex is **self-hosted** on the owner's server. Convex Cloud would place message
plaintext on a third party's infrastructure, which violates principle 1.

## Homeserver: Synapse

Decision: **Synapse with Postgres**, because the mautrix bridges are developed and
tested primarily against it.

- **Not in the client's hot path.** Clients read from Convex; Synapse only relays
  between bridges and the sync service. Its speed does not set the app's feel.
- **No federation.** Federation is disabled, which removes the main source of
  Synapse's slowness (state resolution in large federated rooms).
- **Not exposed.** Synapse listens only on the internal Docker network. Registration
  is disabled; Trioditis creates accounts through the admin API.
- **Tuned for a small install:** Postgres, a single process (no workers), modest
  caches, media retention configured.
- **Swappable later.** The sync service uses only standard Matrix client and
  appservice APIs. A lighter homeserver (e.g. Tuwunel) can be evaluated later behind
  the same boundary, gated by the bridge integration suite.

## Security model

- **Inbound:** each platform's encryption (e.g. Signal and WhatsApp end-to-end
  encryption) terminates at the bridge on the owner's server.
- **Outbound:** messages sent from Trioditis go back through the bridge, which encrypts
  them with the platform's own protocol before they leave the server. A WhatsApp reply
  is end-to-end encrypted to the recipient exactly as if sent from the phone.
- **Platforms without end-to-end encryption** (Slack, Discord, standard Telegram
  chats) are exactly as private as they normally are.
- **Exposure:** only Caddy is public. Synapse, bridges, Postgres, and the sync service
  live on an internal network.
- **Client ↔ server:** TLS via Caddy. Clients only talk to the owner's server.
- **At rest:** the installer recommends full-disk encryption; secrets are generated
  per install, stored with restrictive permissions, never committed.
- **No Matrix-layer E2EE.** Synapse and the bridges share one trust boundary, so
  Matrix encryption would add verification prompts and decryption failures while
  protecting little. Revisit if multi-tenant hosting becomes a goal.
- **Search** runs server-side over the owner's own database.
- **Push notifications** carry no message content; the device wakes and syncs.
- **Agents** hold scoped, revocable tokens; every agent action is audited.

## Clients and code sharing

Decision: TanStack for desktop/web, Expo for mobile, in one pnpm monorepo.

| Layer | Shared? | How |
|---|---|---|
| Convex schema, queries, mutations | Fully | `packages/backend` |
| Types, network metadata, state logic, hooks | Fully | `packages/core` |
| Message rendering logic (markdown, mentions, links, quotes) | Fully | Parse to an AST in core; thin per-platform renderers |
| Local cache logic | Fully | `packages/core` with a storage adapter per platform |
| Design tokens (color, type, spacing, radii, icons) | Fully | `packages/ui-tokens`, consumed by Tailwind (web) and NativeWind (mobile) |
| Display-only leaf components (avatar, network badge, reaction pill, unread dot) | Mostly | React Native primitives, rendered on web via react-native-web |
| Layout, navigation, lists, composer, menus, gestures | Per platform | Native to each platform |

Rule of thumb: **logic is written once; screens are written twice.**

### Offline cache

Convex has no persistent client cache, so clients keep their own:

- Desktop/web: IndexedDB. Mobile: SQLite (expo-sqlite).
- Cached: chat list, the most recent messages of recently opened chats, contacts,
  settings. Media thumbnails cached on disk with a size cap.
- Startup renders from cache immediately, then reconciles with live Convex
  subscriptions.
- Sends made while offline are queued locally with a client-generated ID and flushed
  on reconnect; the same ID makes the send idempotent end to end.

## Repository layout

```
apps/
  desktop/        Electron + TanStack (also builds the web app)
  mobile/         Expo
  sync/           Matrix ↔ Convex sync service, bridge login driver
  push-gateway/   Content-free push relay
packages/
  backend/        Convex functions + schema (+ MCP and webhook HTTP actions)
  core/           Shared types, hooks, logic, cache, message AST
  ui-tokens/      Design tokens
  ui-shared/      Shared leaf components
  config/         Shared tsconfig, ESLint, Prettier
deploy/
  compose/        Docker Compose bundle, pinned versions, config templates
  install/        One-command installer, Proxmox helper
  test/           Bridge integration suite
docs/
```

Tooling: pnpm workspaces, Turborepo, TypeScript strict, Vitest, ESLint + Prettier.
License: AGPL-3.0.

## Data model (Convex, initial sketch)

| Table | Key fields | Notes |
|---|---|---|
| `users` | name, email, role (owner/member) | Better Auth manages auth tables alongside |
| `networkAccounts` | userId, network, bridgeLoginId, status, lastHealthyAt | One per connected login (e.g. "Isaac's WhatsApp") |
| `chats` | userId, networkAccountId, matrixRoomId, kind (dm/group/agent), title, avatar, lastMessageAt, unreadCount, pinned, archived, mutedUntil, labels | Indexed by user + lastMessageAt for the inbox |
| `contacts` | userId, network, displayName, avatar, matrixUserId | Later: merge one person across networks |
| `messages` | chatId, senderContactId, body (raw + AST), attachments, replyToId, editedAt, deletedAt, status, matrixEventId, clientMessageId, sentByAgentId | Unique on matrixEventId and clientMessageId; search index on body |
| `reactions` | messageId, contactId, key | |
| `receipts` | chatId, contactId, upToMessageId | |
| `typing` | chatId, contactId, expiresAt | Ephemeral |
| `outbox` | userId, kind (send/edit/react/redact/read), payload, clientMessageId, state, attempts, lastError | The sync service drains this |
| `media` | mxcUri, mimeType, size, thumbnailMxcUri | Bytes stay in Synapse's media store; no duplication |
| `agents` | name, avatar, ownerUserId, status, oauthClientId | |
| `agentGrants` | agentId, scope (network/chat/all), permission (read/draft/send) | |
| `approvals` | agentId, action, payload, state, decidedBy, decidedAt | Rendered as cards in the agent's thread |
| `auditLog` | actor (user/agent), action, target, at | Append-only |
| `webhooks` | agentId, url, secret, eventTypes | Filtered by agentGrants |
| `devices` | userId, platform, pushToken | |
| `bridgeHealth` | network, state, checkedAt, detail | Feeds the health page and banners |

## Sync service

**Ingest (Matrix → Convex), proposed design, validated in Phase 0:**

- Registers with Synapse as an appservice with a **non-exclusive** user namespace
  covering the household's Matrix users, so Synapse pushes every event in their rooms
  as appservice transactions. Synapse retries failed transactions, giving
  at-least-once delivery without per-user `/sync` loops.
- Each event is upserted into Convex keyed by `matrixEventId`; processed transaction
  IDs are recorded, so replays are harmless.
- Maps Matrix event types to Trioditis models: messages, edits, redactions,
  reactions, receipts, typing, membership, room metadata, and bridge state events
  (login status, send failures).

**Outbound (Convex → Matrix):**

- Clients and agents write intents through Convex mutations, which insert a pending
  message and an `outbox` row in one transaction.
- The sync service subscribes to the outbox, sends to Synapse as the owning user
  (appservice masquerading), using `clientMessageId` as the Matrix transaction ID, so
  retries never double-send.
- The local echo is replaced when the event comes back; the bridge's send-status
  events mark the message sent, delivered, or failed. Failures surface in the UI with
  a retry action.

**Accounts and logins:**

- On user creation, Trioditis creates a hidden Matrix account via the Synapse admin API.
- Bridge logins (QR codes, pairing codes, cookie logins) run through the bridges'
  provisioning API, wrapped in native Trioditis screens. Users never see bridge bot
  commands.

**Media:** clients fetch media through an authenticated Trioditis endpoint that
proxies Synapse's authenticated media API, including thumbnails. Uploads go the other
way through the same endpoint.

**Health:** the sync service polls bridge status, records it in `bridgeHealth`, and
raises an in-app banner when a login expires or a bridge stops responding.

## Networks (v1)

| Network | Bridge | Notes | Tester |
|---|---|---|---|
| WhatsApp | mautrix-whatsapp | Pairing-code login works on the phone itself | Owner |
| Signal | mautrix-signal | Linked device | Owner |
| Google Messages (SMS/RCS) | mautrix-gmessages | Requires an Android phone | Owner |
| Telegram | mautrix-telegram | | Family / friends |
| Discord | mautrix-discord | User-token login; ToS / account-ban risk, shown at login | Family / friends |
| Instagram / Messenger | mautrix-meta | Cookie login; ToS / account-ban risk, shown at login | Family / friends |

Later: Slack, Google Voice, LinkedIn, X, Bluesky. iMessage requires an always-on Mac
and will be an optional, separate component.

## Agents

External agents (Dots, Grokbot, any third-party agent) run as **separate services** and
connect to Trioditis. Trioditis is the hub; it does not host agent logic.

### Agents as conversations

- A built-in **Agents** network sits alongside WhatsApp, Signal, etc. Its messages live
  directly in Convex (no bridge).
- Each agent appears in the inbox as a normal thread: same UI, threads, attachments,
  reactions, notifications.
- Agents can message first (proactive briefs, nudges) and can own additional channels.
- When an agent needs approval, an approval card appears in its thread:
  **Approve / Edit / Reject**. Approvals also work from a push notification on mobile.

### MCP server

- Served from Convex HTTP actions (Streamable HTTP transport) behind Caddy.
- OAuth via Better Auth; each agent is a separately registered client.
- Tools: `list_chats`, `read_messages`, `search`, `draft_reply`, `send_message`,
  `react`, `mark_read`, `post_to_channel`.
- Every tool call is checked against `agentGrants` and written to `auditLog`.

### Events

MCP is request/response, so proactive agents also need push. Trioditis delivers
signed **webhooks** (and optionally a server-sent event stream) filtered by the same
grants: the agent learns something happened, then acts through MCP.

### Agents settings page

- Register, rename, and revoke agents. Revocation invalidates tokens immediately.
- Per agent: which networks and chats it can see, and whether it may **read**,
  **draft**, or **send**.
- Default: read + draft. Sending on the owner's behalf requires approval.
- Optional per-chat auto-send rules, off by default.
- Webhook endpoints and event types.
- Audit log viewer.
- Messages an agent sent are labeled "sent by <agent>" inside Trioditis. Recipients on
  other networks just see the owner.

## Self-hosting

- **Unit of deployment:** a Docker Compose bundle: Caddy, Convex backend, sync
  service, Synapse, Postgres, bridges, push relay client config, web app. Every image
  pinned to an exact version.
- **One command:** `curl -fsSL https://<project>/install.sh | sh`: installs Docker if
  needed, asks for a domain (or uses a local/Tailscale address), generates secrets,
  starts the stack, prints the URL and the first-login link.
- **Proxmox:** a helper script creates an LXC (or VM) and runs the same installer.
  There is one install path to maintain.
- **Portability:** x86_64 and arm64; any distro with Docker. Images published to GHCR
  as multi-arch.
- **Operations:** `trioditis backup`, `trioditis restore`, `trioditis update` (moves
  to the next tested release), and a bridge health page in the app.
- **Sizing target:** comfortable on 2 vCPU / 4 GB RAM for a household (to be measured
  in Phase 1).

## Quality and testing

| Layer | Tooling | Runs in CI |
|---|---|---|
| Unit (core, message AST, cache) | Vitest | Yes |
| Convex functions and permissions | convex-test | Yes |
| Sync service against real Synapse | Vitest + Compose (Synapse, Postgres, Convex) with a fake bridge | Yes |
| Bridge integration suite | Scripted checks against real test accounts | Before each release and version bump |
| Desktop end to end | Playwright (Electron) | Yes |
| Mobile end to end | Maestro | Nightly / pre-release |
| Install | Fresh-VM install of the bundle | Pre-release |

The **bridge integration suite** covers login, send/receive both directions, media,
edits, deletes, reactions, receipts, typing, backfill, and recovery after restarting
each component. No homeserver or bridge version bump ships until it passes.

CI (GitHub Actions): lint, typecheck, unit, Convex tests, the sync service integration
job, and desktop end to end on every PR.

## Roadmap

Each phase ends with explicit acceptance checks.

### Phase 0 — Foundations

- pnpm + Turborepo monorepo with `packages/config`, CI skeleton.
- Compose dev stack: Caddy, Synapse + Postgres, self-hosted Convex, WhatsApp bridge.
- Better Auth on Convex: owner account, sign-in.
- Sync service skeleton: appservice registration, ingest of text messages into Convex.

**Acceptance:** `pnpm dev` brings up the stack; a WhatsApp message sent from a phone
appears in a Convex `messages` row within 2 seconds; CI is green.

### Phase 1 — Core messaging (desktop)

- Inbox and chat UI in Electron: chat list, message list, composer, replies, edits,
  deletes, reactions, media, receipts, typing, unread state, pinning, archive, mute.
- Outbox pipeline with idempotent sends and visible failure/retry.
- WhatsApp, Signal, Google Messages logins through native screens.
- Local cache and instant startup. Search. Bridge health page.

**Acceptance:** the owner uses Trioditis desktop as the daily client for one week
across the three networks with no lost or duplicated messages; cold start shows the
inbox in under 1 second from cache.

### Phase 2 — Mobile

- Expo app: sign-in with server address, inbox, chat, composer, media, search.
- Push gateway and content-free notifications; UnifiedPush option.
- Pairing-code logins on the phone. Agent approval from notifications.

**Acceptance:** a message arriving on any connected network produces a notification
within 5 seconds on iOS and Android; mobile reaches parity with desktop for reading
and replying.

### Phase 3 — More networks

- Telegram, Discord, Instagram/Messenger, with ToS-risk notices at login.
- Family accounts on one server, isolated per user.

**Acceptance:** each network passes the bridge integration suite; family testers use
their own accounts on the owner's server.

### Phase 4 — Agents

- Agents network and threads, MCP server with OAuth, webhooks, grants, approvals,
  audit log, Agents settings page.
- Dots and Grokbot connected as the first two agents.

**Acceptance:** Dots can read a granted chat, draft a reply, and send it only after
the owner approves from desktop or mobile; revoking Dots blocks its next call; every
step appears in the audit log.

### Phase 5 — Release

- Installer polish, Proxmox helper, backup/restore/update commands, docs site.
- Multi-arch images, versioned releases, desktop auto-update, app store builds.

**Acceptance:** a person who has never seen the project installs it on a fresh
Proxmox host with one command and connects WhatsApp in under 15 minutes.

Mobile ships alongside desktop for v1 with a narrower scope: bridge setup and advanced
settings are desktop-first; mobile covers reading, replying, notifications, and agent
approvals.

## Decisions log

| # | Decision | Status |
|---|---|---|
| 1 | Self-hosted, open source; household first, others later | Decided |
| 2 | mautrix bridges + Matrix homeserver as hidden plumbing | Decided |
| 3 | Self-hosted Convex as the data layer for all clients | Decided |
| 4 | Better Auth for authentication | Decided |
| 5 | TanStack desktop/web + Expo mobile, shared core | Decided |
| 6 | Platform encryption ends at the owner's server; re-encrypted outbound by the bridge; no Matrix-layer E2EE | Decided |
| 7 | v1 networks: WhatsApp, Signal, Google Messages, Telegram, Discord, Instagram/Messenger | Decided |
| 8 | Agents external; shown as threads; MCP + webhooks; regulated via settings page | Decided |
| 9 | Docker Compose bundle + one-command installer + Proxmox helper | Decided |
| 10 | License: AGPL-3.0 | Decided |
| 11 | Tooling: pnpm workspaces + Turborepo | Decided |
| 12 | Homeserver: Synapse + Postgres, federation off, internal only | Decided |
| 13 | Clients keep a local cache for instant startup and offline reading | Decided |

## Open questions

1. **Appservice ingest:** confirm the non-exclusive namespace approach delivers every
   bridged-room event reliably with the mautrix bridges (Phase 0).
2. **Convex license:** confirm the self-hosted backend's current license and that
   bundling it as a separate service fits an AGPL-3.0 project and a possible hosted
   offering.
3. **Convex search:** confirm Convex search indexes are good enough for message
   history; fallback is Postgres full-text search or Meilisearch.
4. **Push gateway hosting:** who runs the shared gateway once others self-host, and
   the UnifiedPush/ntfy path for Android users without Google services.
5. **Contact merging:** whether and how to merge one person across networks into a
   single contact (Beeper-style), and when.
6. **iMessage:** whether to support it via an optional Mac companion, and in which
   phase.

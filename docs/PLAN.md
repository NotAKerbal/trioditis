# Trioditis — Product & Implementation Plan

_Trioditis: "of the three roads." A crossroads for all of your conversations._

Status: draft v2, 2026-11-18. v1 of this plan was reviewed by a model council (GPT-6.2
Astra, GPT-6.2 Sol, Claude Fable 5.2, Claude Opus 5.5, Grok 4.7); this revision folds
in its findings and the decisions that followed. Update this document as decisions
change.

## Vision

An open-source, self-hostable alternative to Beeper: one polished app for every
messaging network you use, running on a server you own. Beeper-level polish is the
bar. Setup is one command.

Anyone can host a Trioditis server and invite people to it, the way Vaultwarden is
self-hosted. Each person on a server has their own account and connects their own
networks. The first server is one household; the goal is that anyone can run their
own.

## Principles

1. **Your server, your data.** Bridges and message storage run on the operator's
   server. Nothing in the message path depends on a third-party cloud.
2. **Sealed by default.** Stored messages are encrypted to each person's own keys. The
   operator can run the server without being able to read anyone's history.
3. **Reliability over features.** No lost messages, no duplicates, and an honest
   status when delivery is uncertain. Bridge health is visible, never hidden.
4. **Simple to run.** One command on any Linux box, Proxmox host, VM, or VPS.
   Portable across x86_64 and arm64.
5. **Native-feeling everywhere.** Desktop feels like a desktop app; mobile feels like
   a mobile app. Shared logic, platform-appropriate UI.
6. **Instant by default.** The app opens to your chats immediately, from a local
   cache, before the network answers.
7. **Built to expand.** Every network plugs in through the same connector contract
   and passes the same conformance suite.
8. **Agents are first-class, and on a leash.** Agents appear as conversations, sign in
   with OAuth, and do only what the person allows.

## Architecture

```
WhatsApp · Signal · Google Messages · Telegram · Messenger · Instagram · Discord · …
        │   (each platform's own transport and encryption)
  ┌─────────────────────────────────────────────┐
  │ Bridge host (Go)                            │
  │  mautrix bridgev2 network connectors        │
  │  + Trioditis MatrixConnector (no homeserver)│──► encrypted media store
  │  seals each message to its owner's key      │
  └──────────────┬──────────────────────────────┘
                 │ internal API (events out, commands in)
           Gateway (Node/TS) ──► self-hosted Convex (Postgres) ◄── Better Auth
                 │                   ▲          ▲
   media proxy, webhooks,            │          └── MCP server + OAuth (@convex-dev/mcp)
   login stepper                     │                      ▲
                                     │              external agents (Dots, Grokbot, …)
                 Desktop (Electron + TanStack) · Web · Mobile (Expo)
```

| Component           | Choice                                                         | Role                                                                                             |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Network connectors  | mautrix bridgev2 network connectors (Go)                       | Speak each platform's protocol                                                                   |
| Bridge host         | Go service implementing bridgev2's `MatrixConnector` interface | Hosts the connectors without a Matrix homeserver; seals incoming messages; full-history backfill |
| Gateway             | TypeScript (Node)                                              | Moves events between the bridge host and Convex; media proxy; webhook dispatch; login stepper    |
| Backend / data      | Self-hosted Convex on Postgres                                 | Realtime data for every client: inbox, sealed messages, agents, settings                         |
| Auth (people)       | Better Auth (Convex integration)                               | Accounts, invitations, sessions, passkeys, 2FA                                                   |
| Auth (agents)       | `@convex-dev/mcp`                                              | MCP server and its own OAuth 2.1 server; Better Auth identifies the approving person             |
| Desktop / web       | Electron + Vite + TanStack Router/Query (SPA)                  | Primary client; same build also served as a web app                                              |
| Mobile              | Expo (React Native) + Expo Router                              | Phone client                                                                                     |
| Push                | Project-hosted push relay (Vaultwarden-style)                  | Content-free notifications via APNs/FCM; UnifiedPush option                                      |
| Edge                | Caddy                                                          | Automatic HTTPS; the only publicly exposed service                                               |
| Fallback homeserver | Synapse                                                        | Used only if the bridge host spike fails; see below                                              |

Convex is **self-hosted** on the operator's server, on **Postgres**: the default SQLite
backend has an open out-of-memory issue on large index scans
([convex-backend#495](https://github.com/get-convex/convex-backend/issues/495)).

## Bridge host

The mautrix bridges are split into a **network side** (a `NetworkConnector` per
platform) and a **Matrix side** (the `MatrixConnector` interface in mautrix-go's
`bridgev2` package, MPL-2.0). Normally the Matrix side talks to a homeserver.
Trioditis implements that interface itself, so the connectors run with no Matrix
homeserver at all.

What this buys:

- **Full history.** The interface exposes a batch-sending capability
  (`MatrixCapabilities.BatchSending`, `BatchSend`), which is what lets bridges import
  history beyond the one-time sync at link time. Standard homeservers can only backfill
  into new, empty rooms.
- **No Synapse.** No homeserver, no second Postgres, no appservice registration, no
  transaction-ID caveats, no double-puppeting setup: the bridge host knows which
  messages are the person's own.
- **Stable dedup keys.** The interface generates deterministic event IDs per remote
  message, which become Trioditis's dedup key.
- **Earliest possible sealing.** Incoming messages are encrypted to their owner's key
  inside the bridge host, before anything else sees them.

Shape:

- One Go module, `apps/bridge-host`, built once with all supported connectors.
- One process per network (selected by flag), so a crashing connector can't take down
  the others.
- bridgev2's own database (portal, ghost, message mappings, login sessions) on the
  shared Postgres, in a separate schema, on an encrypted volume.
- An internal API to the gateway: a durable outgoing event journal (acknowledged only
  after the Convex commit) and an incoming command channel (send, edit, react, redact,
  read, typing, login steps).

Risks and mitigations:

- **Untested path upstream.** mautrix developers test against Synapse. Pin exact
  connector and mautrix-go versions; no bump ships until the conformance suite passes.
- **Interface churn.** The interface can change between mautrix-go releases. Keep the
  implementation thin and covered by tests against each pinned release.
- **Legacy bridges.** mautrix-discord still uses the legacy (non-bridgev2) framework.
  Discord waits for its bridgev2 migration, or we contribute to it.
- **Unknown unknowns.** No production deployment of bridgev2 without a homeserver has
  been found. The Phase 0 spike proves it with WhatsApp before anything else is built.

**Fallback:** if the spike fails, Trioditis uses Synapse (Postgres, federation off,
internal only) with the mautrix bridges as normal appservices, a double-puppet
registration, and a sync service in place of the bridge host. History is then limited
to the import at link time.

## Accounts and administration

- **Roles:** the server has admins and members. The first account is the admin.
- **Invitations:** admins invite people by link or email. There is no open sign-up
  unless the admin enables it.
- **Admin panel:** invite and remove people, choose which networks are enabled on the
  server, see bridge health and resource use, run backups and updates. The admin panel
  never shows message content.
- **Per-person networks:** each person connects their own accounts. Nothing is shared
  between people, even if two members are in the same WhatsApp group; each sees their
  own copy through their own login.
- **Multiple logins per network:** a person can connect more than one account on the
  same network.
- **Sign-in:** passkeys preferred; password plus TOTP supported; 2FA required for
  admins.

## Sealed storage

Goal: the operator can run the server, back it up, and administer it without being
able to read anyone's stored messages.

### Keys

- Each person has an identity key pair. The private key never leaves their devices.
- On their devices it is protected by a key-wrapping key derived from their passkey
  (WebAuthn PRF) or password (Argon2id), plus a **recovery key** shown once at setup.
- New devices are approved from an existing device (QR scan) or with the recovery key.
- Every sealed object has its own random **content key**, sealed to each recipient's
  public key. The server can encrypt to a person but can never decrypt what it stored.
  (An earlier draft used per-chat keys; the server would have needed them in the clear
  to encrypt incoming messages.) The exact format is `docs/architecture/sealing.md`.

### What is sealed

| Sealed (encrypted to the person)                                  | Visible to the server                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Message bodies, attachments, link previews                        | Message IDs, timestamps, sender IDs, delivery state            |
| Media files (encrypted per file, key inside the message envelope) | File sizes, content types                                      |
| Chat names, avatars, topics                                       | Network, chat kind, unread counts, pinned/archived/muted flags |
| Contact names, handles, avatars                                   | Opaque contact IDs                                             |
| Drafts                                                            | Draft existence                                                |

### Flows

- **Incoming:** the bridge host seals each message to the person's identity key (and the
  agent-access key, for chats granted to an agent) before writing it to its journal,
  then forgets the content key. Convex and the gateway only ever see ciphertext.
- **Outgoing:** the client encrypts the message for the bridge host's public key and
  writes it to the outbox; the bridge host decrypts, sends, and discards the
  plaintext. The client also stores its own copy, sealed to the person's recipients.
- **Search:** runs on the device, over a local index built as messages are decrypted
  (SQLite FTS5 on mobile and desktop). Server-side message search does not exist.
- **Push:** notifications never contain message content.
- **Agents:** granting an agent a chat adds the server's agent-access key as a
  recipient: new messages include it from the start, and the person's device re-seals
  the content keys of past messages to it (without re-encrypting content). The MCP
  server can then decrypt that chat for that agent. The grant screen says so plainly.
  Revoking the grant removes those recipient entries.

### What sealing cannot do

The bridge host must see each message in plaintext as it passes through, and it holds
each person's network sessions (WhatsApp, Signal, …). An operator who modifies the
running server could capture new messages or act as a connected account. This is true
of every bridge-based system. The app tells invited members this when they join and
when they connect a network.

Losing every device and the recovery key means losing access to sealed history.
Network accounts can be re-linked, and history re-imported where the network allows.

## Security model

- **Inbound:** each platform's encryption terminates at the bridge host on the
  operator's server; the bridge host seals messages immediately.
- **Outbound:** the bridge host re-encrypts with the platform's own protocol. A
  WhatsApp reply is end-to-end encrypted to the recipient exactly as if sent from the
  phone. Platforms without end-to-end encryption are as private as they normally are.
- **Exposure:** only Caddy is public. The bridge host, gateway internals, Postgres and
  the Convex dashboard live on an internal network. Convex's two origins (API and HTTP
  actions) are proxied by Caddy; telemetry is off (`DISABLE_BEACON`).
- **Access checks:** every query, mutation, media fetch and MCP call checks the caller
  owns the data or holds a grant for it.
- **Client hardening:** Electron with sandboxing, context isolation, a strict CSP, and
  message HTML rendered only through the sanitized message AST. Local caches are
  encrypted with a device key.
- **Secrets:** generated per install, stored with restrictive permissions, never
  committed. Bridge sessions live in the bridge host database on an encrypted volume.
- **Supply chain:** images pinned by digest; the installer is checksummed and signed.
- **Disappearing and view-once messages:** timers are honoured across Convex, device
  caches and local search; backups made after expiry don't contain them.

## Reliability

### Ingest (network → Convex)

- The bridge host appends each event (already sealed) to a durable journal and
  delivers it to the gateway in order per chat.
- The gateway writes it to Convex with a check-then-insert on the deterministic event
  ID inside one mutation (Convex has no unique constraints), then acknowledges. The
  bridge host retries anything unacknowledged.
- Events that can't be mapped are quarantined and reported on the health page instead
  of blocking the feed.
- A **reconciler** compares bridgev2's message table with Convex per chat at startup,
  after a restore, and on a schedule, and repairs gaps. A `rebuild` command reprojects
  Convex from the bridge host's records.
- Messages are ordered by the network's timestamp with a stable tie-breaker, never by
  arrival. Backfilled messages are flagged historical: no notification, no unread bump,
  no inbox reordering.

### Outbound (Convex → network)

- Sends are written as an outbox row with a client-generated `clientMessageId`,
  carried all the way to the bridge host and recorded against the resulting network
  message.
- The gateway claims outbox rows with a lease, FIFO per chat.
- States: `queued → claimed → submitted → sent → delivered → read`, plus `failed` and
  `unknown`.
- **No automatic resend after an ambiguous outcome.** If the bridge host can't confirm
  whether the network accepted a send, the message shows "delivery unknown" and the
  person chooses whether to retry (risking a duplicate) or discard.
- Sends queued longer than a configurable limit (default 24 hours) expire and ask the
  person before going out.
- After a restore, every non-terminal outbox row is marked "needs confirmation"; nothing
  is sent until the person confirms.

### Measuring it

A **canary ledger** runs from Phase 0: two test accounts exchange sequence-numbered
messages continuously, and a checker reports any gap or duplicate. "No lost or
duplicated messages" is judged against the ledger, not by feel.

## Clients and code sharing

TanStack for desktop/web, Expo for mobile, in one pnpm monorepo.

| Layer                                                         | Shared?      | How                                                                      |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| Convex schema, queries, mutations                             | Fully        | `packages/backend`                                                       |
| Types, network capability metadata, state logic, hooks        | Fully        | `packages/core`                                                          |
| Crypto (sealing, key wrapping, device approval)               | Fully        | `packages/crypto`, audited primitives only (libsodium)                   |
| Message rendering logic (markdown, mentions, links, quotes)   | Fully        | Parse to an AST in core; thin per-platform renderers                     |
| Local cache and on-device search                              | Fully        | `packages/core` with a storage adapter per platform                      |
| Design tokens (color, type, spacing, radii, icons)            | Fully        | `packages/ui-tokens`, consumed by Tailwind (web) and NativeWind (mobile) |
| Screens, layout, navigation, lists, composer, menus, gestures | Per platform | Native to each platform                                                  |

Rule of thumb: **logic is written once; screens are written twice.** Components are not
shared through react-native-web.

### Offline cache

- Desktop/web and mobile keep an encrypted local store (SQLite) of the chat list,
  recent messages of recently opened chats, contacts, settings, and the search index.
- Startup renders from the cache immediately, then reconciles with live Convex
  subscriptions.
- Sends made offline queue locally with their `clientMessageId` and flush on reconnect.

## Product scope (Beeper-class)

Beyond reading and replying, v1 includes:

- Starting new chats and groups from contacts on each network.
- Replies, edits, deletes, reactions, mentions with autocomplete, threads where the
  network has them.
- Media: images, video, files, voice notes (record and play), stickers and GIFs, link
  previews.
- Read receipts, typing indicators, mark as unread, message requests.
- Pin, archive, mute, labels (Trioditis-side where the network can't sync them back).
- Drafts synced across devices.
- Per-chat notification settings; desktop notifications.
- Keyboard-first navigation and a command palette on desktop.
- Unified inbox with filters by network, unread, and label.

Later: contact merging across networks, scheduled messages, reminders/snooze, iMessage
via an optional Mac companion.

## Connector platform

Every network is a bridgev2 `NetworkConnector` registered in the bridge host. Adding a
network means delivering:

1. **The connector** — an existing mautrix connector, or a new one written against the
   same interface.
2. **A capability manifest** — what the network supports (edits, reactions, voice
   notes, threads, read receipts, message requests, size limits). The UI adapts to it.
3. **Login flow** — described with bridgev2's standard login steps (QR display and
   wait, pairing code, user input, cookies). One generic login stepper in Trioditis
   renders every network's login; no per-network login screens.
4. **Conformance results** — the suite below, passing.
5. **A maturity label** — stable, beta, or experimental, shown in the app.

### Conformance suite

- **Automated:** runs against a fake network connector in CI; covers the connector
  contract, ordering, dedup, sealing, outbox states, restart recovery, and backfill.
- **Live checklist:** scripted checks against real test accounts — login, send and
  receive both ways, a message sent from the phone, media, edits, deletes, reactions,
  receipts, typing, backfill, re-link without duplicates, and killing each component
  mid-traffic.
- A network is **stable** when it passes both and has run a week on the canary ledger
  with no gaps or duplicates.

This makes networks parallelizable: one agent per network, and "done" means its
conformance results are green.

## Networks

| Network                   | Connector                                    | Status at plan time                                                           | Target maturity for v1                     |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| WhatsApp                  | mautrix-whatsapp (bridgev2)                  | Phase 0 spike network                                                         | Stable                                     |
| Signal                    | mautrix-signal (bridgev2)                    |                                                                               | Stable                                     |
| Google Messages (SMS/RCS) | mautrix-gmessages (bridgev2)                 | Google-account cookie login; QR login no longer works; phone must stay online | Stable                                     |
| Telegram                  | mautrix-telegram (rewritten in Go, bridgev2) |                                                                               | Beta                                       |
| Messenger                 | mautrix-meta (bridgev2)                      | Messenger only since v26.08; cookie login; ToS / ban risk                     | Beta                                       |
| Instagram                 | mautrix-instagram (bridgev2)                 | Split out of mautrix-meta in v26.07; cookie login; ToS / ban risk             | Beta                                       |
| Discord                   | mautrix-discord                              | Still on the legacy framework; user-token login; ToS / ban risk               | Experimental, after its bridgev2 migration |

Later candidates: Slack, Google Voice, LinkedIn, X, Bluesky, iMessage (optional Mac
companion). Testers for Telegram, Discord and Instagram are friends and family with
those accounts.

## Agents

External agents (Dots, Grokbot, any MCP-capable agent) run as separate services and
connect to Trioditis. Trioditis is the hub; it does not host agent logic.

### Agents as conversations

- A built-in **Agents** network sits alongside the bridged networks. Its messages live
  directly in Convex.
- Each agent appears in the inbox as a normal thread, and can own extra channels.
- Agents can message first (briefs, nudges).
- Approval requests appear as cards in the agent's thread: **Approve / Edit / Reject**.
  Approvals are decided only from a signed-in human session (with device unlock on
  mobile), including from a notification.

### Sign-in: OAuth with `@convex-dev/mcp`

Modeled on Fluxalytics, which uses the same stack:

- `@convex-dev/mcp` is both the MCP server and its own OAuth 2.1 server. Better Auth's
  OAuth-provider and MCP plugins are not used (they are incompatible with Convex).
- An agent registers itself and sends the person to `/agents/connect`. The consent page
  identifies the person through their Better Auth session, shows the agent's name, the
  scopes requested and where approval returns, and refuses to be framed.
- Tokens are issued for that person; every tool runs as them and no tool accepts a user
  ID. Each tool declares its scope and an enforced return shape.
- The web app forwards `/mcp` and the OAuth discovery documents to Convex, so tokens are
  bound to the server's own address. Cookies are never forwarded.
- Settings → Agents lists connections with Disconnect, backed by the component's
  connection APIs. Disconnecting revokes immediately.
- Target the current MCP spec revision (2026-07-28, stateless).
- The component is alpha: pin its exact version, and confirm it on self-hosted Convex
  in Phase 0.

### Scopes, grants and approvals

- **Scopes** (OAuth): `read`, `draft`, `send`, `channels` (post to its own threads).
- **Grants** (Trioditis): per chat or per network, owned by the person who granted
  them. A new agent starts with **no** access.
- Granting read access to a chat makes its content decryptable by the MCP server for
  that agent (see Sealed storage), and the grant screen says the agent may pass that
  content to its own AI provider.
- **Approvals** are bound to a hash of the exact payload, recipient and attachments,
  and expire. Grants are rechecked at dispatch.
- Optional per-chat auto-send rules, off by default; they can never widen grants.
- Rate limits per agent and a global kill switch.
- Inbound message text is treated as untrusted input to agents (prompt injection); tool
  descriptions say so.

### Events

- Signed webhooks with timestamps, carrying IDs and event types only (no content); the
  agent fetches content through MCP, where grants apply.
- Webhook egress goes through an allowlist so agents can't point webhooks at internal
  services.

### Audit

Every MCP call, approval, grant change and agent-sent message is written to an
append-only audit log, viewable in Settings → Agents. Messages an agent sent are labeled
"sent by <agent>" inside Trioditis; recipients on other networks see the person.

## Self-hosting

- **Unit of deployment:** a Docker Compose bundle: Caddy, Convex backend, Postgres,
  gateway, bridge host (one container per enabled network), web app. Every image pinned
  by digest.
- **One command:** `curl -fsSL https://<project>/install.sh | sh` installs Docker if
  needed, asks for a domain, generates secrets, starts the stack, and prints the admin
  setup link.
- **Install modes:** a public domain with ACME certificates (default), or a Tailscale
  `ts.net` name. Phones won't trust a self-signed local CA, so LAN-only installs are not
  supported for mobile.
- **Proxmox:** a helper script creates a VM (default) or LXC and runs the same
  installer.
- **Portability:** x86_64 and arm64; images published to GHCR as multi-arch.
- **Sizing:** 8 GB RAM recommended until measured; initial history imports are the
  peak. Measured in Phase 0 and published.
- **Operations (from Phase 1):**
  - `trioditis backup` — encrypted, coordinated snapshot of Postgres (Convex and the
    bridge host), the media store and secrets; pauses sends, push and webhooks while it
    runs.
  - `trioditis restore` — restores a snapshot, marks pending sends as needing
    confirmation, and runs the reconciler.
  - `trioditis update` — moves to the next tested release; a fast lane ships
    connector-only updates the same day (networks expire old client versions).

### Project-hosted services

Like Vaultwarden using Bitwarden's push relay, the project hosts only what a
self-hoster can't:

- **Push relay:** each install registers for an installation ID and key; the relay
  forwards content-free notifications to APNs/FCM for the project's published apps. The
  project owns the APNs key.
- Notifications are visible but generic ("New message"); delivery latency is measured
  as p50/p95 on real devices.
- UnifiedPush/ntfy for Android users without Google services.
- Later, if needed: an optional tunnel relay for installs without a public address.
  Until then, Cloudflare Tunnel or Tailscale Funnel are documented.

## Repository layout

```
apps/
  desktop/        Electron + TanStack (also builds the web app)
  mobile/         Expo
  bridge-host/    Go: bridgev2 MatrixConnector, connectors, sealing, journal
  gateway/        Node: event pipeline, media proxy, webhooks, login stepper
  push-relay/     Project-hosted push relay
packages/
  backend/        Convex functions + schema, MCP server
  core/           Shared types, hooks, logic, cache, message AST
  crypto/         Sealing, key wrapping, device approval
  ui-tokens/      Design tokens
  config/         Shared tsconfig, ESLint, Prettier
deploy/
  compose/        Docker Compose bundle, pinned versions, config templates
  install/        One-command installer, Proxmox helper
conformance/      Fake network connector, automated suite, live checklist, canary ledger
docs/
```

Tooling: pnpm workspaces, Turborepo, TypeScript strict, Vitest, ESLint + Prettier; Go
modules for the bridge host. License: AGPL-3.0.

## Data model (Convex, initial sketch)

All rows are scoped to one person. Sealed fields are ciphertext envelopes.

| Table             | Key fields                                                                                                                                                                                      | Notes                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `users`           | role (admin/member), identityPublicKey                                                                                                                                                          | Better Auth tables alongside                   |
| `invitations`     | email, invitedBy, expiresAt, acceptedAt                                                                                                                                                         |                                                |
| `devices`         | userId, platform, devicePublicKey, pushRegistration, approvedAt                                                                                                                                 |                                                |
| `networkAccounts` | userId, network, loginId, status, lastHealthyAt                                                                                                                                                 | Several per network allowed                    |
| `chats`           | userId, networkAccountId, portalId, kind (dm/group/channel/agent), sealedMeta, lastMessageAt, unreadCount, pinned, archived, mutedUntil, labels, parentSpaceId                                  | Indexed by user + lastMessageAt                |
| `contacts`        | userId, networkAccountId, ghostId, sealedProfile                                                                                                                                                |                                                |
| `messages`        | userId, chatId, eventId, networkTs, sortKey, senderContactId, sealedBody, kind, relatesTo (reply/edit/reaction/redaction/thread), status, clientMessageId, historical, expiresAt, sentByAgentId | Dedup by eventId via index + check-then-insert |
| `readMarkers`     | userId, chatId, upToSortKey                                                                                                                                                                     | Unread counts derived, with a repair job       |
| `typing`          | chatId, contactId, expiresAt                                                                                                                                                                    | Ephemeral                                      |
| `outbox`          | userId, chatId, kind, sealedForBridge, clientMessageId, state, leaseUntil, attempts, lastError, createdAt                                                                                       | FIFO per chat                                  |
| `media`           | userId, objectId, size, contentType                                                                                                                                                             | Bytes in the encrypted media store             |
| `drafts`          | userId, chatId, sealedText, updatedAt                                                                                                                                                           |                                                |
| `agents`          | userId, mcpConnectionId, name, avatar, status                                                                                                                                                   |                                                |
| `agentGrants`     | agentId, grantedBy, scope (chat/network), permission                                                                                                                                            |                                                |
| `approvals`       | agentId, payloadHash, sealedPayload, state, expiresAt, decidedBy, decidedAt                                                                                                                     |                                                |
| `auditLog`        | actor, action, target, at                                                                                                                                                                       | Append-only                                    |
| `webhooks`        | agentId, url, secret, eventTypes                                                                                                                                                                |                                                |
| `bridgeHealth`    | network, loginId, state, checkedAt, detail                                                                                                                                                      |                                                |
| `quarantine`      | eventId, reason, at                                                                                                                                                                             | Unmappable events                              |

## Quality and testing

| Layer                                                                                  | Tooling                                                                              | Runs in CI                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| Unit (core, crypto, message AST, cache)                                                | Vitest                                                                               | Yes                                    |
| Convex functions and access checks                                                     | convex-test                                                                          | Yes                                    |
| Bridge host and gateway pipeline                                                       | Go tests + Vitest against the fake network connector, Convex and Postgres in Compose | Yes                                    |
| Agent security (negative tests: no grant, expired approval, revoked token, wrong user) | convex-test + MCP client                                                             | Yes, from the first MCP PR             |
| Conformance live checklist                                                             | Scripted, real test accounts                                                         | Before each release and connector bump |
| Canary ledger                                                                          | Continuous, two test accounts                                                        | Always on in the dev environment       |
| Desktop end to end                                                                     | Playwright (Electron)                                                                | Yes                                    |
| Mobile end to end                                                                      | Maestro                                                                              | Nightly / pre-release                  |
| Install                                                                                | Fresh-VM install of the bundle                                                       | Pre-release                            |

CI (GitHub Actions): lint, typecheck, unit, Convex tests, pipeline integration and
desktop end to end on every PR.

## Roadmap

Each phase ends with explicit acceptance checks. Mobile work can start once Phase 0
lands, in parallel with Phase 1, because the core is shared.

### Phase 0 — Foundations and bridge host spike

- pnpm + Turborepo monorepo, Go module, CI skeleton.
- Compose dev stack: Caddy, Convex on Postgres, gateway, bridge host with the WhatsApp
  connector.
- Better Auth on Convex: admin account, invitations, passkey sign-in.
- Bridge host implementing `MatrixConnector`, including batch sending; journal; sealing
  with a prototype key flow.
- `@convex-dev/mcp` running on self-hosted Convex with one read-only tool.
- Canary ledger running.

**Acceptance** (one real WhatsApp account, with the canary ledger running throughout):

- A message from someone else, a message sent from the phone, and a message sent from
  Trioditis each appear exactly once, under the right sender, in order.
- Media, an edit and a reaction round-trip.
- History older than the link-time import loads through batch sending.
- Killing each component mid-traffic loses and duplicates nothing.
- An outbound send whose confirmation is dropped ends in `unknown`, not a resend.
- Re-linking the account produces no duplicates.
- Two people on the same server in the same WhatsApp group each see their own copy.
- Stored messages in Convex and Postgres are ciphertext.
- Memory use during the initial import is measured.

If the bridge host can't meet this, switch to the Synapse fallback before Phase 1.

### Phase 1a — WhatsApp daily driver (desktop)

- Inbox and chat UI: chat list, message list, composer, replies, edits, deletes,
  reactions, media, receipts, typing, unread, pin, archive, mute.
- Outbox with all delivery states and the unknown-delivery flow.
- Full sealed storage: device approval, recovery key, encrypted local cache, on-device
  search.
- Backup, restore and update commands, including the connector fast lane.
- Bridge health page and admin panel basics.

**Acceptance:** the owner uses Trioditis desktop as their daily WhatsApp client for one
week with zero gaps or duplicates on the canary ledger; cold start shows the inbox in
under 1 second from cache; a backup restored to a fresh VM comes back with history and
pending sends held for confirmation.

### Phase 1b — Connector platform and core networks

- Capability manifests, generic login stepper, conformance suite (automated and live).
- Signal and Google Messages to stable.
- Beeper-class scope: new chats, voice notes, link previews, stickers/GIFs, mention
  autocomplete, message requests, mark unread, synced drafts, per-chat notifications,
  desktop notifications, command palette.

**Acceptance:** WhatsApp, Signal and Google Messages pass the conformance suite and a
week on the canary ledger; adding a network requires no new login UI.

### Phase 2 — Mobile and push

- Expo app: sign-in with server address, device approval, inbox, chat, composer,
  media, on-device search, encrypted cache.
- Push relay and visible generic notifications; UnifiedPush option.
- Pairing-code logins on the phone; approval cards from notifications.

**Acceptance:** notification latency p95 under 10 seconds and p50 under 3 seconds on
real iOS and Android devices; mobile reaches parity with desktop for reading, replying
and search.

### Phase 3 — More networks

- Telegram, Messenger and Instagram to beta; Discord when its bridgev2 migration lands.
- ToS-risk notices at login for cookie- and token-based networks.
- One agent per network working from the connector platform.

**Acceptance:** each network passes the automated suite and the live checklist, and
carries its maturity label in the app.

### Phase 4 — Agents

- Agents network and threads, OAuth consent page, scopes, grants with sealed-key
  wrapping, approvals, webhooks, rate limits, kill switch, audit log, Settings →
  Agents.
- Dots and Grokbot connected as the first two agents.

**Acceptance:** Dots can read a granted chat, draft a reply, and send it only after the
owner approves the exact payload; an expired or edited approval is rejected; revoking
Dots blocks its next call; every step appears in the audit log; the negative test suite
is green.

### Phase 5 — Release

- Installer polish, Proxmox helper, docs site, project-hosted push relay in production.
- Multi-arch images, versioned releases, desktop auto-update, app store builds.

**Acceptance:** someone who has never seen the project installs it on a fresh Proxmox
host with one command, invites a second person, and connects WhatsApp in under 15
minutes.

## Decisions log

| #   | Decision                                                                                                                          | Status                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | Self-hosted, open source, Vaultwarden-style; anyone can host and invite people                                                    | Decided                        |
| 2   | mautrix bridgev2 network connectors as the network layer                                                                          | Decided                        |
| 3   | Own bridge host implementing `MatrixConnector`; no homeserver; Synapse only as fallback                                           | Decided, pending Phase 0 spike |
| 4   | Self-hosted Convex on Postgres as the data layer                                                                                  | Decided                        |
| 5   | Better Auth for people; `@convex-dev/mcp` for agent OAuth (Fluxalytics pattern)                                                   | Decided                        |
| 6   | TanStack desktop/web + Expo mobile, shared core; no react-native-web component sharing                                            | Decided                        |
| 7   | Sealed storage by default for every account; per-object content keys sealed to each recipient; agents get access per granted chat | Decided                        |
| 8   | Platform encryption ends at the bridge host; re-encrypted outbound by the connector                                               | Decided                        |
| 9   | Separate accounts per person; admin panel; admin chooses enabled networks                                                         | Decided                        |
| 10  | All six v1 networks ship with maturity labels; connector platform + conformance suite                                             | Decided                        |
| 11  | No automatic resend after an ambiguous outcome; "delivery unknown" state                                                          | Decided                        |
| 12  | Public domain default; Tailscale option; project-hosted push relay                                                                | Decided                        |
| 13  | Backup, restore and update from Phase 1                                                                                           | Decided                        |
| 14  | License: AGPL-3.0; Convex backend (FSL-1.1-Apache-2.0) is a documented source-available dependency                                | Decided                        |
| 15  | Tooling: pnpm workspaces + Turborepo; Go modules for the bridge host                                                              | Decided                        |

## Open questions

1. **Bridge host spike:** does bridgev2 run fully without a homeserver (provisioning,
   commands, backfill, media), and how much of `MatrixAPI` each connector actually
   exercises?
2. **Bridge database contents:** confirm which connectors store message content (not
   just IDs) in bridgev2's database, and seal or prune it.
3. **Key recovery UX:** how device approval, recovery keys and passkey PRF fallback
   feel in practice, especially on mobile.
4. **On-device search at scale:** index size and speed on years of history on phones.
5. **Bridge host topology:** one process per network (planned) vs. one per person per
   network for stronger isolation.
6. **Discord:** wait for upstream's bridgev2 migration, or contribute to it.
7. **Push relay operations:** hosting, abuse limits and costs once others self-host.
8. **Contact merging and iMessage:** whether and when.

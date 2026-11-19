# Bridge host

The bridge host runs mautrix bridgev2 network connectors (WhatsApp, Signal, …) with no
Matrix homeserver. It implements bridgev2's `MatrixConnector` itself: what a connector
"sends to Matrix" becomes sealed protocol events in a durable journal, pushed to the
gateway, and gateway commands become the Matrix-side events bridgev2 expects.

Contracts: [`docs/architecture/bridge-protocol.md`](../../docs/architecture/bridge-protocol.md)
and [`docs/architecture/sealing.md`](../../docs/architecture/sealing.md). Background:
[`docs/PLAN.md`](../../docs/PLAN.md), Bridge host.

## Layout

```
cmd/bridge-host/       the binary: run, login (terminal), inspect (dev)
internal/connector/    the MatrixConnector and MatrixAPI intents; commands; logins
internal/seal/         sealing, byte-compatible with packages/crypto
internal/store/        journal, command dedup, send state, opaque IDs, key cache, membership
internal/gateway/      journal pusher with heartbeats; key fetching
internal/server/       POST /v1/commands
internal/media/        encrypted media store
internal/keys/         recipient keys, cached in memory and in the database
internal/ids/          Matrix-shaped IDs on a fake server; opaque protocol IDs
internal/devkeys/      dev identity keys, for trying it without the gateway
internal/host/         assembles a process; the conformance suite
internal/testconnector/ the connector the host's tests drive; not a network, never built in
```

## Run it

Go 1.27 (`~/.local/go/bin/go` on the dev VM).

```sh
cd apps/bridge-host
go build -o bin/bridge-host ./cmd/bridge-host

# Against the gateway (env from .data/dev.env):
GATEWAY_URL=… TRIODITIS_INTERNAL_TOKEN=… BRIDGE_PUBLIC_KEY=… BRIDGE_PRIVATE_KEY=… \
  ./bin/bridge-host --network whatsapp run

# Without a gateway at all, sealing to dev keys kept in the data directory:
./bin/bridge-host --network whatsapp --dev-keys run
```

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_NETWORK` | `whatsapp` | Network (`--network`, listed by `--help`), such as `whatsapp`, `signal` or `telegram` |
| `BRIDGE_HOST_ID` | `<network>-1` | Stable host ID; the gateway maps it to this host's URL |
| `BRIDGE_HOST_ADDR` | `127.0.0.1:8611` | Command server address |
| `BRIDGE_DATA_DIR` | `.data/bridge-host` | Database, media and dev files |
| `BRIDGE_DATABASE_TYPE` / `_URI` | SQLite in the data dir | `postgres` and a URI for production |
| `GATEWAY_URL` | none | Required, unless `--dev-keys` is given (then nothing is pushed) |
| `TRIODITIS_INTERNAL_TOKEN` | none | Bearer token both ways |
| `BRIDGE_PUBLIC_KEY` / `BRIDGE_PRIVATE_KEY` | generated in dev | Bridge key pair, base64url X25519. In dev it is generated once into `bridge-key.json` and kept. Opaque IDs don't depend on it (see Design), so it can be rotated |

### Try WhatsApp from the terminal

This needs your phone. It runs the same login commands the gateway would send, with dev
identity keys kept in the data directory (never do that in production):

```sh
./bin/bridge-host --network whatsapp --dev-keys --user isaac --flow qr login      # scan the QR
./bin/bridge-host --network whatsapp --dev-keys --user isaac --flow phone login   # or a pairing code
# in another terminal, follow the journal, decrypted with the dev key:
./bin/bridge-host --network whatsapp --user isaac inspect
```

Ctrl+C (or SIGTERM) ends `login` at any point, a prompt included, and stops the host
cleanly. `login` exits with status 1 if the login fails or is interrupted.

## Design

- **No homeserver.** `Connector` implements `bridgev2.MatrixConnector` (including the
  unexported bot-intent getter `NewBridge` asserts) and `Intent` implements `MatrixAPI` for
  the bot, ghosts and each person's double puppet. Users, ghosts and rooms have
  Matrix-shaped IDs on the fake server `trioditis.internal`. Room IDs encode the portal key
  reversibly, so a room alone identifies its owner.
- **Split portals and double puppeting, always.** Every portal has a receiver login, so a
  shared group is a separate portal per person. `NewUserIntent` always succeeds, so a
  person's own messages, from any device, arrive as `{"self": true}`.
- **Full history.** `MatrixCapabilities.BatchSending` is on; `BatchSend` turns history into
  `message` events flagged `historical`.
- **Deterministic event IDs.** Hashes of portal key, message ID and part ID, the dedup key
  Convex uses. Our own sends use a hash of the user and `clientMessageId`.
- **Opaque protocol IDs.** `portalId`, `ghostId` and `loginId` are keyed hashes (`p_…`,
  `g_…`, `l_…`) because network IDs contain phone numbers. The reverse map is in
  `trioditis_id`. The hashing key is created once per database (`trioditis_secret`) and
  kept, so a new bridge key changes no ID; a database from before it existed keeps the key
  its IDs were made with. A portal's ID is hashed from the key its room was created with and
  stands for the room, so it survives the network re-IDing the portal (WhatsApp moving a
  chat from a phone number to a LID): commands find the current portal by room.
- **Sealing at the earliest point.** Content is sealed to the owner's identity key (plus
  the agent-access key for granted portals) before it reaches the journal. Keys come from
  the gateway, cached a minute in memory and indefinitely in the database, so sealing
  continues while the gateway is down: bridgev2 never retries a message the Matrix side
  failed to take.
- **Journal.** Append-only, sequence-numbered, in the same database as bridgev2. Sequence
  numbers come from a counter in the appending transaction, never a database sequence, so
  a rolled-back append leaves no gap for the gateway to wait on. A batch from `BatchSend`
  is appended in one transaction. The pusher sends batches in order and advances only on
  the gateway's acknowledgement; a `409` asking for a sequence the journal can't have is
  reported rather than resent, and a repeated one backs off. A login's QR or pairing code
  is scrubbed from the journal once acknowledged. It
  heartbeats with an empty batch on startup and every 30 seconds, and adopts the gateway's
  `ackedThrough` (resending if the gateway is behind).
- **Commands are stored before they are acknowledged.** The server checks a command and
  stores it, payload included, in `trioditis_command`, and only then answers `202`; a
  worker runs stored commands in arrival order. A command acknowledged is never lost: one
  interrupted before its send was recorded runs after a restart, and one whose send was
  recorded is settled as `unknown`. A login in progress is recorded in
  `trioditis_login_session` until its last step is reported, so one interrupted by a
  restart ends with an error, and input sent to it afterwards ends it too. A command's
  payload (sealed to the bridge key) is deleted once it has run and any failure it had is
  recorded; a failure that can't be recorded leaves the command for the next start.
- **One lane per chat.** A chat's commands run on their own goroutine, one at a time, so a
  chat stuck inside a connector holds up only itself; commands without a chat (logins) run
  on the worker. Stopping waits up to 10 seconds for lanes, and anything still running is
  settled at the next start.
- **Synchronous chats.** bridgev2 runs with `PortalEventBuffer: 0`: a chat's events are
  handled in the goroutine that queues them, so a send reaches the connector as soon as its
  lane lets it go, with no queue in between. For WhatsApp this also keeps whatsmeow's
  decrypted-event buffer on (see Plaintext at rest).
- **One writer.** The bridge host's own write transactions run one at a time in the
  process (a transaction inside another joins it), so they can't take the journal counter and
  ID rows in opposite orders and deadlock on PostgreSQL.
- **Sends, one at a time per chat, in order.** Only a chat's earliest waiting command is
  ever started, so commands for one chat can't overtake each other, and the next command
  waits until a send, edit, reaction or redaction has an outcome. `notAfter` (required on
  every send, and best effort once a send is handed off; see Spike findings) is checked when the send starts and again as the last step before it is
  handed to bridgev2, after sealing and recording, with a margin (`HandoffMargin`, 11
  minutes) for what bridgev2 may still wait on before the connector transmits: the chat's
  lock, which an incoming event holds for at most bridgev2's handler limit (5 minutes) before
  it is backgrounded, behind up to two such events, and a reconnecting login
  (`SendReconnectWait`, 30 seconds). It is checked once more, with `TransmitMargin` (2
  minutes), when the connector reads a send's attachment through the bridge host, the last
  code of ours a media send passes through; refused there, the connector can't send the
  media and the send fails as `expired`. For a text send nothing of ours runs between
  bridgev2 taking the lock and the connector transmitting: bridgev2 calls the connector
  directly, with its own context for the chat (no deadline of ours reaches it), and the
  WhatsApp connector relies on its own client type (`login.Client.(*WhatsAppClient)`), so its
  client can't be wrapped to check later. The hand-off records `submitted`; bridgev2's
  message status then records `sent` with the person's own copy (sealed at hand-off),
  `failed` (only if bridgev2 is certain) or `unknown`, each status committed together with
  the events reporting it, retried until it commits. No outcome within the send timeout is
  `unknown`, except that while bridgev2 still holds the send (it may be waiting for the
  chat's lock behind a slow incoming event, so may not have started) it is only marked
  unknown after three timeouts (9 minutes by default). The chat's next command doesn't start
  before a command's handler has finished: if bridgev2 stops waiting on a send, edit,
  reaction or redaction (after five minutes it backgrounds the handler and returns), the
  chat stays held, even once a send is marked unknown, until bridgev2 reports the outcome.
  The hold always ends, though: when bridgev2 deletes the chat (it reports no outcome for a
  deleted chat, so a send still out is marked `unknown` then), when the handler returns, or
  at the latest ten send timeouts after it was due (`holdLimit`, 30 more minutes by default),
  for a connector that never returns. A command whose chat was released without an outcome
  is remembered for an hour, so an outcome that arrives later is still recorded (a reaction
  that finally goes through is reported then). Outcomes are written with a fresh context per
  attempt from the bridge's lifetime, not the chat's, so a chat deleted while its send is out
  doesn't stop the outcome being recorded; one still unwritten when the bridge stops stays
  `submitted` and becomes `unknown` at the next start. A send in flight at a restart becomes
  `unknown`. Nothing is ever retried. A repeated `clientMessageId` repeats the last status.
  Relations (replies, edit, reaction and read targets) must belong to the command's chat.
- **Sizes.** Every event is checked against the backend's validator before it is journaled
  (`Event.Validate`; the JSON carries exactly its type's fields), and what is sealed is
  measured as sealed: chat and contact metadata fits 8 KiB (topic or handle cut first, then
  the name), and a message or edit fits 256 KiB (formatted body dropped, then the body cut at
  a character boundary, marked `truncated`); the person's own copy of a send is fitted the
  same way. A send or edit sealing more than a client may (64 KiB) is refused with `400`.
  The pusher never sends an event over 1 MiB; an older journal row that big goes as a bare
  stand-in the gateway quarantines. An outcome whose events the journal refuses is never
  retried (that would hold its chat for good): a send is recorded `unknown` and the chat
  goes on, with only a code logged.
- **Errors are codes.** Events and 4xx bodies carry only protocol error codes. Details are
  logged locally.
- **Logins** follow bridgev2's login process API, emitting `loginStep` events; input
  arrives sealed to the bridge key and is cleared after use.
- **Media.** Connector uploads stay in memory (10 minutes) until a sealed object
  references them, then an encrypted copy per person is written to disk with its key in
  the sealed plaintext. Outbound attachments are registered from the sealed send. A
  connector that needs a real file (WhatsApp, for media over 5 MiB) gets one only on tmpfs
  (`/dev/shm`), removed straight after; without tmpfs the media is refused rather than
  written to disk. Media files are opened without following symlinks.
- **Agent grants** from the gateway are honoured for 10 minutes while it is unreachable;
  after that only the person's identity key is used.

## Checks

```sh
go vet ./...
go test ./...                       # seal vectors both ways, and the conformance suite
go test -race -count=3 ./internal/host/  # all but background_test.go (see Known follow-ups)
pnpm --filter @trioditis/crypto test  # TypeScript opens vectors-go.json
```

The conformance suite (`internal/host/conformance_test.go`) runs a real bridge host with
`internal/testconnector` against a fake gateway and checks:

- every event against the backend's field validators
- registration heartbeat
- login through commands, and one submit per login step
- incoming messages sealed to their owner only
- sealed chat and contact metadata
- history through `BatchSend`
- attribution of self-sent messages
- network resend deduplication
- edits, reactions, reaction removal, redactions, receipts and typing
- the send states (`sent`, `unknown`, `failed`, expired), repeated sends and idempotent command IDs
- `notAfter` required, checked at hand-off behind a slow send in the same chat, and again
  when the connector reads an attachment
- a send or edit sealing more than a client may (64 KiB) refused with `400`
- (in `background_test.go`, without `-race`; see Known follow-ups) a send or reaction still
  running after bridgev2 stops waiting holding its chat, with a reaction's late outcome
  recorded; a send in a chat deleted while it runs (no outcome from bridgev2) ending
  `unknown` and releasing the chat; a connector that never returns releasing it after
  `holdLimit`
- a late outcome after a timeout still recorded as `sent`
- replies refused into another chat
- a send in flight at a restart ends `unknown` and is never sent
- logins scoped to their owner
- two people in one chat
- sealed attachments in both directions
- journal resends after partial acks, failures and conflicts
- ordering and exactly-once delivery across a restart
- error codes and well-formed events
- a grep of every file on disk for plaintext content

`internal/host/recovery_test.go` adds: a stored command running after a restart, a
handed-off send settled as `unknown`, IDs surviving a new bridge key, a portal keeping its
ID through a re-ID, and login codes scrubbed once acknowledged. `TestPostgres` runs the
core flow on PostgreSQL when `TRIODITIS_TEST_POSTGRES_URI` names a scratch database.
`internal/store` tests the portal-value migration, the gap-free journal and the ID key.
`internal/protocol` tests each event type's exact JSON fields and the checks before
journaling; `internal/connector` that escaped metadata and oversized messages seal within
their limits, and that an outcome the journal can never take is recorded as `unknown` and
releases its chat; `internal/gateway` that an event too large to send goes as a stand-in;
`internal/wabuffer`, on a seeded whatsmeow store, that the sweep deletes only rows past 14
days, keeps sweeping, and stops while its parent context is live; `cmd/bridge-host` that
SIGINT or SIGTERM at a login prompt, with stdin left open, stops the host and exits 1.
`vectors-go.json` is only rewritten with `TRIODITIS_WRITE_VECTORS=1`.

## Spike findings

### Verified

- bridgev2 runs with this connector and no homeserver: the conformance suite passes (also under the race detector).
- The WhatsApp connector (`mautrix-whatsapp v0.2611.0`, `mautrix v0.33.0`) builds, starts,
  creates its schemas, and reaches the QR login step against WhatsApp's servers under this
  connector. **Not verified:** completing a pairing, live messages, history sync, media and
  sends with a real account. That needs a phone.

### What the WhatsApp connector touches

These come from reading the connector's source. The generic bridgev2 paths (`SendMessage`, `BatchSend`, `CreateRoom`,
`SendState`, receipts, typing, uploads, ghost profiles) are exercised by the conformance
suite. WhatsApp additionally uses:

- `Bridge.Bot.DownloadMedia`: outbound media and group avatars. Served from the media
  store.
- `Bridge.Bot.SendState`: member changes during the LID migration. Handled.
- `Bridge.Bot.GetEvent`: only to recover the previous version of an edited media caption.
  **Stubbed** (returns an error); the connector logs it and carries on, so a caption edit
  may lose the media's info fields.
- `Matrix.GetMemberInfo`: relay mode only. Answered from the membership table.
- `Matrix.GenerateContentURI`: direct media only, which isn't enabled.
- `MatrixConnectorWithArbitraryRoomState`: optional, **not implemented**; the LID migration
  skips its member-state check.
- **`Init` type-asserts bridgev2's real `commands.Processor`.** The host uses it, with a
  command prefix nobody can type, so no message is ever taken as a bot command.

### Stubbed or not covered

- These are no-ops: `MarkUnread`, `TagRoom` and `MuteRoom` (mark-unread, tags and mute aren't
  synced from networks yet), and `SetExtraProfileMeta` and `SetProfile`.
- These are dropped: polls, call notices and other unsupported event types.
- A send carries at most one attachment.
- The `backfill` command fetches `limit` messages before `beforeEventId` (or the oldest
  bridged message) through the connector and imports them; `more` is the network's answer,
  and slow fetches (asking the phone) are allowed so it can be followed. It is refused
  (`unsupported`) for WhatsApp: its connector treats an empty result for the requested range
  as the end of history and deletes every cached history row for the chat, including newer
  ones not imported yet. WhatsApp history arrives through bridgev2's own backfill instead.
- **`notAfter` is best effort for WhatsApp sends in Phase 0.** A send handed to bridgev2 can
  still reach the network after `notAfter`, by any amount (bridge-protocol.md, Delivery
  rules): behind more than two incoming events that each hit bridgev2's 5-minute handler
  limit, after a slow media upload, or behind whatsmeow's send lock. That lock is one per
  login (`go.mau.fi/whatsmeow` `send.go`, `messageSendLock`), taken by every send in all of
  the person's chats and held until the server acknowledges the message, and it doesn't
  honour a context. The first wait for that acknowledgement is 75 seconds, but after a
  disconnect whatsmeow resends the frame and waits for it with no timeout (`retryFrame` is
  called with timeout 0, `request.go`), still holding the lock: if the new connection stays
  up and the acknowledgement never comes, every chat on that login waits indefinitely, and a
  send queued behind it transmits after `notAfter` once the lock clears. A late send is
  reported truthfully, never as `expired`: `sent` if the network confirms it while the host
  still remembers the send (up to an hour after its chat was released without an outcome),
  else `unknown`.
- **whatsmeow resends a frame after a disconnect.** If the connection drops after a message
  frame went out but before WhatsApp acknowledged it, whatsmeow waits up to 5 seconds for a
  reconnect and sends the same frame again, with the same message ID, inside the same
  connector call (`request.go`, `retryFrame`). So one send can be transmitted twice at the
  transport level; WhatsApp deduplicates by message ID, so recipients should see it once.
  This is why a connector error after the hand-off is `unknown`, not `failed`: the first
  frame, the repeat, or both may have been delivered. The bridge host itself never sends
  again.
- Outbound attachments expect the client's ciphertext already at
  `<data>/media/<network>/<mediaId>`. Nothing puts it there yet; that is the gateway's
  media path.
- If the gateway acknowledges more than the journal holds (the journal was reset), the
  pusher reports an error and stops advancing. That needs an operator procedure.
- Acknowledged journal rows aren't pruned yet. They are sealed to people, not readable by
  the bridge.

### Plaintext at rest: needs a decision

The bridge host's own tables and the journal hold no plaintext content (grepped in the
suite). But the connectors' own storage, in the same database, does:

- **bridgev2's `portal` table** stores chat names and topics, **`ghost`** stores contact
  names and identifiers (phone numbers), and **`user_login`** stores the remote name.
  bridgev2 needs them for change detection.
- **WhatsApp's `whatsapp_history_sync_message`** stores raw history-sync message protobufs
  (`data bytea`, plaintext content) until they are backfilled. The connector already deletes
  each batch once imported (its `CompleteCallback`), so rows only remain for history not yet
  imported. Deleting them earlier would lose that history, so the host doesn't.
- whatsmeow's store holds the session keys (expected; it is what makes the bridge work)
  and its contacts table, which has push names and phone numbers.
- **whatsmeow's `whatsmeow_event_buffer`** holds each incoming message's decrypted protobuf
  (`plaintext`, content included). mautrix-whatsapp turns it on because the host runs
  bridgev2 with `PortalEventBuffer: 0` (`EnableDecryptedEventBuffer`), and the host keeps it
  that way: a Signal message can be decrypted only once, so the buffered copy is what lets a
  message whose handling failed, or was cut off by a crash, be bridged when WhatsApp
  redelivers it (it isn't acknowledged until it is handled). Turning it off would lose that
  message. The row is written in the decrypting transaction, and its plaintext is cleared
  when the handler returns success: normally once the message is journaled sealed (usually
  moments), but bridgev2 also reports success when its 5-minute handler limit passes, while
  handling carries on (see below). Plaintext stays in a row only when handling failed
  or the process stopped in between (the message wasn't acknowledged, so WhatsApp redelivers
  it, and the redelivery is bridged and cleared), or when clearing it failed with a database
  error (whatsmeow logs it and still acknowledges the message, so nothing clears it). Either
  way the row is deleted by the first sweep that succeeds once it is about 14 days old
  (WhatsApp's redelivery window): whatsmeow sweeps only after an incoming message, at most
  every 12 hours, so the host runs the same sweep itself, at start-up and hourly
  (`internal/wabuffer`), and stops it before the host on shutdown. A sweep that fails (the
  database unavailable, say) leaves the row for the next one. A row
  can't be cleared any sooner: it has no message ID to tell whether it was bridged, and a row
  without plaintext makes whatsmeow drop the redelivery as already handled. One case loses a
  message instead: after its 5-minute handler limit bridgev2 reports success while handling
  carries on in the background, so whatsmeow clears the plaintext and acknowledges; if the
  process stops before the sealed event is journaled, WhatsApp doesn't redeliver it. Outgoing
  messages kept for retry receipts stay in memory (`use_whatsapp_retry_store` is off).
- A connector's media conversion can write a replacement file (for example a converted
  voice note) wherever the connector chooses; the host reads and removes it, but doesn't
  choose where it was written.

Phase 0 decision: all of these are covered by keeping the bridge host database on an
encrypted disk with encrypted backups (`docs/architecture/sealing.md`, What else is stored in
plaintext). Options for Phase 1:

- an encrypted volume for the bridge host database (the Phase 0 decision)
- pruning or minimizing those columns where bridgev2 allows
- configuring WhatsApp's history sync to keep the window short

### Known follow-ups

Accepted for the Phase 0 spike, to do in Phase 1:

- **Connector logs.** bridgev2's own log lines include connector error text, which can
  quote content (see Other risks). Redact or filter them, and set log retention.
- **Journal pruning.** Acknowledged journal rows are kept indefinitely. Prune them after a
  retention window (they are sealed, but they grow).
- **Legacy journal gaps.** A v1 database migrated to v2 keeps any sequence gaps the old
  identity column left. Detect and repair them on upgrade, or document an operator reset.
- **Avatar rehydration.** A device that first sees a chat after its avatar upload expired
  has no avatar until it changes. Keep a durable sealed avatar reference to resend.
- **Media buffering.** Large media is buffered fully in memory; stream it.
- **Plaintext at rest** in connector storage (above): decide between an encrypted volume
  only, sealing those columns with a server key, or patching connectors.
- **Explicit WhatsApp backfill.** Re-enable "load older" for WhatsApp once fetching a range
  can't prune outside it (an upstream change, or a guard around its history store).
- **Live checks.** WhatsApp pairing, messaging and history haven't been run. On PostgreSQL,
  `TestPostgres` (the core flow) has passed on PostgreSQL 16.15 at `793c3eb` and on 17.7 at
  an earlier revision; the rest of the conformance suite hasn't been run there.
- **Deadline at transmission.** `notAfter` is checked at hand-off with an 11-minute margin,
  and for media again when the attachment is read; after that it is best effort. Enforcing
  it at the moment of transmission needs a pre-send hook in bridgev2 that takes a deadline
  (or a connector that tolerates a wrapped client, or whatsmeow honouring a context while it
  waits for its send lock), and whatsmeow bounding its wait for a retransmitted frame's
  acknowledgement; propose both upstream.
- **A chat held by a stuck connector.** A command whose handler never returns holds its chat
  for up to `holdLimit` (about 40 minutes from the hand-off by default) before the chat is
  released. Add an operator command to release one sooner, and a metric for it.
- **Login recovery edge cases.** A submit for a login that recovery already ended gets
  `invalid_command` rather than `login_failed`, and a login started before the v3 migration
  has no row to recover, so it isn't ended with an error.
- **bridgev2 race on a backgrounded handler (upstream).** When bridgev2 stops waiting on a
  handler (`handleSingleEventWithDelayLogging`, mautrix v0.33.0 `bridgev2/portal.go`), the
  handler's goroutine still writes the result the caller is returning, unsynchronized. In
  production that needs a handler to finish just as its 5-minute limit passes; the tests that
  make bridgev2 background every handler at once hit it often, so they live in
  `internal/host/background_test.go` behind `//go:build !race` and run only without
  `-race`.
- **Report the bridgev2 race upstream, then restore race coverage.** File the race above
  with mautrix (both the write and the read are in `bridgev2/portal.go`, lines 457 and 493 in
  v0.33.0). Once a release fixes it, drop the `!race` build tag from `background_test.go` so
  its four cases (a send held, a reaction held with its late outcome, a deleted chat, the
  hold limit) run under `-race` again.
- **Shutdown and stuck connectors.** A connector call that never returns leaves its chat's
  goroutine (and the wait for it) behind when the host stops in-process; process exit
  reclaims them.
- **Ack cost.** Each acknowledgement scrubs login codes by scanning the acknowledged part of
  the journal; with journal pruning that stays small, without it the cost grows.

### Other risks

- bridgev2's own log lines include connector error text (for example "Failed to handle
  Matrix message" with the error). The host can't change them; keep its log level at warn
  or above in production and treat its logs as sensitive.
- Large media is buffered fully in memory.
- Avatars older than the 10-minute upload window can't be attached to later `chat` and
  `contact` events; those carry `avatarUnchanged: true` instead, and clients keep the avatar
  they have. A client with no copy (a new device) shows none until the avatar changes.
- The connector is pinned to `mautrix v0.33.0`. Every bump needs this suite plus the live
  checklist, since mautrix isn't tested against a non-homeserver Matrix side.

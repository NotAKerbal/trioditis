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
pkg/fakenet/           a fake network connector for tests and the dev stack
```

## Run it

Go 1.27 (`~/.local/go/bin/go` on the dev VM).

```sh
cd apps/bridge-host
go build -o bin/bridge-host ./cmd/bridge-host

# Against the gateway (env from .data/dev.env):
GATEWAY_URL=… TRIODITIS_INTERNAL_TOKEN=… BRIDGE_PUBLIC_KEY=… BRIDGE_PRIVATE_KEY=… \
  ./bin/bridge-host --network whatsapp run

# The fake network, for the dev stack without a real account:
./bin/bridge-host --network fake run
```

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_NETWORK` | `whatsapp` | Network (`--network`): `whatsapp` or `fake` |
| `BRIDGE_HOST_ID` | `<network>-1` | Stable host ID; the gateway maps it to this host's URL |
| `BRIDGE_HOST_ADDR` | `127.0.0.1:8611` | Command server address |
| `BRIDGE_DATA_DIR` | `.data/bridge-host` | Database, media and dev files |
| `BRIDGE_DATABASE_TYPE` / `_URI` | SQLite in the data dir | `postgres` and a URI for production |
| `GATEWAY_URL` | none | Without it, dev keys are used and nothing is pushed |
| `TRIODITIS_INTERNAL_TOKEN` | none | Bearer token both ways |
| `BRIDGE_PUBLIC_KEY` / `BRIDGE_PRIVATE_KEY` | generated in dev | Bridge key pair, base64url X25519. In dev it is generated once into `bridge-key.json` and kept: opaque IDs derive from it |
| `BRIDGE_FAKE_CONTROL_ADDR` | none | `--network fake` only: a loopback endpoint (`POST /fake/incoming`, internal token) for the end-to-end script to deliver messages. Dev only |

### Try WhatsApp from the terminal

This needs your phone. It runs the same login commands the gateway would send, with dev
identity keys kept in the data directory (never do that in production):

```sh
./bin/bridge-host --network whatsapp --user isaac --flow qr login      # scan the QR
./bin/bridge-host --network whatsapp --user isaac --flow phone login   # or a pairing code
# in another terminal, follow the journal, decrypted with the dev key:
./bin/bridge-host --network whatsapp --user isaac inspect
```

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
  `trioditis_id`.
- **Sealing at the earliest point.** Content is sealed to the owner's identity key (plus
  the agent-access key for granted portals) before it reaches the journal. Keys come from
  the gateway, cached a minute in memory and indefinitely in the database, so sealing
  continues while the gateway is down: bridgev2 never retries a message the Matrix side
  failed to take.
- **Journal.** Append-only, sequence-numbered, in the same database as bridgev2. The
  pusher sends batches in order and advances only on the gateway's acknowledgement. It
  heartbeats with an empty batch on startup and every 30 seconds, and adopts the gateway's
  `ackedThrough` (resending if the gateway is behind).
- **Sends.** A `send` inserts a durable outgoing row and emits `submitted` before bridgev2
  sees it. bridgev2's message status becomes `sent` (then the person's own sealed copy),
  `failed` (only if bridgev2 is certain) or `unknown`. No outcome within the send timeout
  is `unknown`; a send in flight at a restart becomes `unknown`. Nothing is ever retried.
  A repeated `clientMessageId` repeats the last status. `notAfter` in the past gives
  `failed` / `expired`. Plaintext of a send is held in memory only until its outcome.
- **Errors are codes.** Events and 4xx bodies carry only protocol error codes. Details are
  logged locally.
- **Logins** follow bridgev2's login process API, emitting `loginStep` events; input
  arrives sealed to the bridge key and is cleared after use.
- **Media.** Connector uploads stay in memory (10 minutes) until a sealed object
  references them, then an encrypted copy per person is written to disk with its key in
  the sealed plaintext. Outbound attachments are registered from the sealed send.

## Checks

```sh
go vet ./...
go test ./...                       # seal vectors both ways, and the conformance suite
go test -race -count=3 ./internal/host/
pnpm --filter @trioditis/crypto test  # TypeScript opens vectors-go.json
```

The conformance suite (`internal/host/conformance_test.go`) runs a real bridge host with
`fakenet` against a fake gateway and checks:

- registration heartbeat
- login through commands
- incoming messages sealed to their owner only
- sealed chat and contact metadata
- history through `BatchSend`
- attribution of self-sent messages
- network resend deduplication
- edits, reactions, reaction removal, redactions, receipts and typing
- the send states (`sent`, `unknown`, `failed`, expired), repeated sends and idempotent command IDs
- logins scoped to their owner
- two people in one chat
- sealed attachments in both directions
- journal resends after partial acks, failures and conflicts
- ordering and exactly-once delivery across a restart
- error codes and well-formed events
- a grep of every file on disk for plaintext content

## Spike findings

### Verified

- bridgev2 runs with this connector and no homeserver: the fake-network conformance suite
  passes (also under the race detector).
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
- The `backfill` command runs bridgev2's next backfill task for the portal; `beforeEventId`
  and `limit` are ignored.
- `notAfter` is checked when the command arrives. Time spent queued inside bridgev2's
  portal loop isn't covered.
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
  (`data bytea`, plaintext content) until they are backfilled, then deletes them.
- whatsmeow's store holds the session keys. This is expected; it is what makes the bridge
  work.

Options:

- an encrypted volume for the bridge host database (assumed by the plan)
- pruning or minimizing those columns where bridgev2 allows
- configuring WhatsApp's history sync to keep the window short

### Other risks

- bridgev2's own log lines include connector error text (for example "Failed to handle
  Matrix message" with the error). The host can't change them; keep its log level at warn
  or above in production and treat its logs as sensitive.
- Large media is buffered fully in memory.
- Avatars older than the 10-minute upload window are left out of later `chat` and
  `contact` events. The client keeps the one it already has.
- The connector is pinned to `mautrix v0.33.0`. Every bump needs this suite plus the live
  checklist, since mautrix isn't tested against a non-homeserver Matrix side.

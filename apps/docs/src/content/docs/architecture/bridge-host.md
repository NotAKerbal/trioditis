---
title: Bridge Host Internals
description: Architecture, invariants, conformance tests, and connector details for apps/bridge-host (Go).
---

`apps/bridge-host` is a single Go module that hosts `mautrix` `bridgev2` network connectors without a Matrix homeserver. Each enabled network runs as its own process (`bridge-host --network <slug> run`), translating connector events into sealed protocol events and gateway commands into `bridgev2` actions.

## Package layout

```
apps/bridge-host/
  cmd/bridge-host/       CLI entry point: run, login (terminal), inspect (dev)
  internal/connector/    MatrixConnector & MatrixAPI intents, command dispatch, logins
  internal/seal/         XChaCha20-Poly1305 + NaCl sealed box (compatible with packages/crypto)
  internal/store/        Gap-free journal, command dedup, send state, opaque IDs, key cache
  internal/gateway/      Ordered journal pusher, heartbeats, recipient key fetcher
  internal/server/       POST /v1/commands internal HTTP server
  internal/media/        Encrypted per-user media store (tmpfs-only staging when required)
  internal/keys/         In-memory (60s) + persistent recipient key cache
  internal/ids/          Fake Matrix-shaped IDs & keyed-hash opaque protocol IDs
  internal/devkeys/      Local dev key helper for standalone testing
  internal/host/         Process wiring and the automated conformance suite
  pkg/fakenet/           In-memory fake network connector for tests and dev stacks
```

## Key design invariants

- **Split portals & automatic double-puppeting:** Every portal belongs to a specific receiver login so two members in the same WhatsApp group maintain completely isolated portals. `NewUserIntent` always succeeds, attributing messages sent from a member's phone cleanly as `{"self": true}`.
- **Opaque, stable IDs:** `portalId` (`p_...`), `ghostId` (`g_...`), and `loginId` (`l_...`) are keyed hashes stored in `trioditis_id` using a persistent per-database secret (`trioditis_secret`). Rotating `BRIDGE_PRIVATE_KEY` does not alter IDs, and portals survive upstream re-IDs (such as WhatsApp phone-to-LID migrations).
- **Gap-free journal:** Sequence numbers come from an in-transaction counter inside the bridge database (never an auto-increment sequence that can leave gaps on rollback). `BatchSend` history batches commit atomically in one transaction.
- **Durable commands & per-chat lanes:** `POST /v1/commands` persists each command in `trioditis_command` before answering `202`. Each chat executes commands serially on its own goroutine so a slow connector call in one chat never blocks others.
- **Synchronous `bridgev2` delivery:** `PortalEventBuffer: 0` eliminates hidden intermediary queues and keeps `whatsmeow`'s decrypted-event buffer active so crashes mid-message never drop single-decryption WhatsApp messages.
- **Safe media staging:** Incoming attachments remain in memory (up to 10 minutes) until referenced, then write encrypted to disk. Connectors requiring a file path (WhatsApp for media > 5 MiB) only stage on `tmpfs` (`/dev/shm`) and delete immediately; if `tmpfs` is absent, the transfer is refused rather than touching persistent disk.

## Running standalone

Requires Go 1.27 (`PATH` or `~/.local/go`).

```sh
cd apps/bridge-host
go build -o bin/bridge-host ./cmd/bridge-host

# Run against a local gateway
GATEWAY_URL=http://127.0.0.1:8700 TRIODITIS_INTERNAL_TOKEN=... \
  ./bin/bridge-host --network fake run

# Try WhatsApp directly from the terminal using dev keys (dev only)
./bin/bridge-host --network whatsapp --dev-keys --user demo --flow qr login
./bin/bridge-host --network whatsapp --user demo inspect
```

### Configuration environment variables

| Variable                                   | Default               | Purpose                                                               |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------- |
| `BRIDGE_NETWORK`                           | `whatsapp`            | Network connector (`--network`): `whatsapp` or `fake`                 |
| `BRIDGE_HOST_ID`                           | `<network>-1`         | Stable host ID mapped in the gateway's `BRIDGE_HOSTS`                 |
| `BRIDGE_HOST_ADDR`                         | `127.0.0.1:8611`      | Command listener address                                              |
| `BRIDGE_DATA_DIR`                          | `.data/bridge-host`   | SQLite DB (dev), encrypted media, dev keys                            |
| `BRIDGE_DATABASE_TYPE` / `_URI`            | SQLite                | Set to `postgres` + connection URI in production                      |
| `GATEWAY_URL`                              | —                     | Gateway base URL (required unless `--dev-keys`)                       |
| `TRIODITIS_INTERNAL_TOKEN`                 | —                     | Shared bearer token                                                   |
| `BRIDGE_PUBLIC_KEY` / `BRIDGE_PRIVATE_KEY` | Auto-generated in dev | X25519 bridge key pair (unpadded base64url)                           |
| `BRIDGE_FAKE_CONTROL_ADDR`                 | —                     | Dev-only loopback endpoint (`POST /fake/incoming`) for `fake` network |

## Conformance suite

```sh
cd apps/bridge-host
go vet ./...
go test ./...
go test -race -count=3 ./internal/host/
```

The automated conformance suite (`internal/host/conformance_test.go` and `recovery_test.go`) drives a full bridge host with `fakenet` against a mock gateway to verify:

- Every emitted event matches Convex's exact field validators and error codes.
- Heartbeats, login step submission and code scrubbing, and per-user isolation (two users in one chat).
- Full-history import via `BatchSend`, self-sent attribution, edits, reactions, redactions, receipts, typing, and attachments in both directions.
- Outbound send states (`submitted`, `sent`, `failed`, `unknown`), `notAfter` margins, idempotent `commandId`s, and zero automatic retries after restarts.
- Disk grep confirming zero plaintext message content in the bridge host's own tables or journal.
- PostgreSQL compatibility (`TestPostgres` when `TRIODITIS_TEST_POSTGRES_URI` is set).

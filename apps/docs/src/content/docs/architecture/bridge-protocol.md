---
title: Bridge Protocol (v1)
description: Internal HTTP/JSON protocol contract between the Go bridge host and Node gateway.
---

The bridge protocol is the internal API between each Go bridge host (`apps/bridge-host`) and the Node gateway (`apps/gateway`). Both run exclusively on the server's internal network using JSON over HTTP authenticated with a shared bearer token (`TRIODITIS_INTERNAL_TOKEN`).

```
bridge host ── POST /v1/events ──────────────► gateway ──► Convex
bridge host ◄── POST /v1/commands ─────────── gateway ◄── Convex outbox
bridge host ── GET  /v1/keys/:userId ────────► gateway      (recipient public keys)
```

The gateway listens on `GATEWAY_INTERNAL_ADDR` (default `127.0.0.1:8601`). Each bridge host has a stable `hostId` (`BRIDGE_HOST_ID`, default `<network>-1`) and listens on `BRIDGE_HOST_ADDR` (default `127.0.0.1:8611`). The gateway routes commands **only** to configured addresses in `BRIDGE_HOSTS` (`whatsapp-1=http://127.0.0.1:8611,...`) and refuses HTTP redirects.

## Identifiers

| Identifier        | Description                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `network`         | Slug: `whatsapp`, `signal`, `gmessages`, `telegram`, `meta`, `instagram`, `discord`, `fake`     |
| `userId`          | Trioditis member ID (Convex `members` row)                                                      |
| `loginId`         | Opaque bridgev2 login ID (`l_...`), unique per network; `""` before login completes             |
| `portalId`        | Opaque chat/portal ID (`p_...`), unique per network (network IDs like phone numbers never leak) |
| `eventId`         | Deterministic hash per remote message part; serves as the dedup key                             |
| `ghostId`         | Opaque remote contact ID (`g_...`), unique per network                                          |
| `clientMessageId` | Client-generated ID carried end-to-end for outbound sends                                       |

## Events: bridge host → gateway

`POST /v1/events`

```json
{
  "hostId": "whatsapp-1",
  "network": "whatsapp",
  "events": [{ "seq": 1042, "type": "message", "userId": "...", "loginId": "l_...", "at": 1732200000000 }]
}
```

### Delivery semantics

- `seq` increments strictly by 1 per event per host and survives restarts.
- Events arrive in order. `200 {"ackedThrough": 1042}` means every event through `1042` has been committed to Convex (or quarantined).
- Delivery is at-least-once; the bridge host resends from `ackedThrough + 1`. Convex deduplicates on `eventId` and `(hostId, seq)`.
- `ackedThrough` may be lower than the batch's last `seq` if Convex stopped early to stay inside transaction limits.
- `409 {"expectedSeq": n}` instructs the host to resend starting at `n`.
- **Heartbeats:** On startup and every 30 seconds, the host posts an empty batch (`events: []`) to register liveness and learn `ackedThrough`. Hosts silent for over 2 minutes stop receiving commands.
- **Size limits:** Max 100 events and 8 MiB JSON per batch (gateway rejects bodies over 32 MiB). Individual events over 1 MiB are quarantined.

### Pressure and backpressure

Every batch, heartbeats included, may carry `"pressure": {"backlog": 12, "pushMs": 850, "failedPushes": 0}`: the journal events not yet acknowledged, how long the host's last delivery took to be answered (ms), and its deliveries that failed in the last five minutes. They are counts only. The gateway passes them on if all three are non-negative numbers and drops them otherwise; Convex keeps each host's at most every 30 seconds (`bridgePressure`) for **Settings → Admin → Server health**.

The host also acts on them, so a server short of CPU isn't swamped by history while people are using it:

- After a delivery that took a second or more, the next waits as long again (at most 10 seconds).
- Older history waits while the server is behind: more than 300 events unacknowledged, a delivery slower than two seconds, or one that failed in the last 30 seconds. bridgev2's backfill queue (which also runs someone scrolling back) waits before its next task, before it takes any chat's lock, for two minutes at most (`BeforeBackfillTask`, third_party/mautrix.patch). Live messages and a chat's forward catch-up never wait.

### Event types

Every event includes `seq`, `type`, `userId`, `loginId`, and `at` (ms):

| Type             | Fields                                                                                                                             | Notes                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`        | `portalId`, `eventId`, `networkTs`, `sender`, `sealed`, `historical`, `replyTo?`, `threadRoot?`, `clientMessageId?`, `mentionsMe?` | `sender` is `{"self": true}` or `{"ghostId": "..."}`. `sealed` uses kind `message`, object ID `eventId`                                                                                                                                                                                                                |
| `edit`           | `portalId`, `eventId`, `targetEventId`, `networkTs`, `sender`, `sealed`, `clientMessageId?`                                        | Sealed with edit's own `eventId`                                                                                                                                                                                                                                                                                       |
| `reaction`       | `portalId`, `eventId`, `targetEventId`, `sender`, `key`, `networkTs`                                                               | `key` is the unsealed emoji (variation selectors stripped)                                                                                                                                                                                                                                                             |
| `reactionRemove` | `portalId`, `targetEventId`, `sender`, `key`                                                                                       | Removes an active reaction                                                                                                                                                                                                                                                                                             |
| `redaction`      | `portalId`, `targetEventId`, `sender`, `networkTs`                                                                                 | Deleted for everyone                                                                                                                                                                                                                                                                                                   |
| `receipt`        | `portalId`, `sender`, `upToEventId`, `networkTs`                                                                                   | Read receipt                                                                                                                                                                                                                                                                                                           |
| `typing`         | `portalId`, `sender`, `typing`, `timeoutMs`                                                                                        | Ephemeral typing indicator                                                                                                                                                                                                                                                                                             |
| `chat`           | `portalId`, `kind`, `sealed`, `parentPortalId?`, `deleted?`, `isRequest?`                                                          | Upsert (`dm`, `group`, `channel`, `space`); `sealed` holds name/topic/avatar, and in a `dm` `dmGhostId`: the other person (max 8 KiB)                                                                                                                                                                                  |
| `chatCollage`    | `portalId`, `sealed`                                                                                                               | The members whose pictures make a group's picture when it has none (kind `chat`, object ID `<portalId>/collage`, `{"ghosts": [...]}`: up to 4, never the person, pictured first; empty for a DM). Sealed to the person only, apart from `chat`, which it never replaces; sent only when the choice changes (max 8 KiB) |
| `contact`        | `ghostId`, `sealed`                                                                                                                | Upsert; `sealed` holds name/handle/avatar (max 8 KiB)                                                                                                                                                                                                                                                                  |
| `loginState`     | `state`, `error?`                                                                                                                  | `CONNECTING`, `CONNECTED`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`, `UNKNOWN_ERROR`, `LOGGED_OUT`                                                                                                                                                                                                                    |
| `loginStep`      | `loginSessionId`, `step`                                                                                                           | Interactive login stepper update                                                                                                                                                                                                                                                                                       |
| `sendStatus`     | `clientMessageId`, `status`, `eventId?`, `error?`                                                                                  | `submitted`, `sent`, `delivered`, `read`, `failed`, `unknown`                                                                                                                                                                                                                                                          |
| `backfillDone`   | `portalId`, `direction`, `more`                                                                                                    | History import progress                                                                                                                                                                                                                                                                                                |

### One schema for both sides

The backend's `bridgeEvent` validator (`packages/backend/convex/validators.ts`) is the one description of these events, with `MAX_SEALED_BYTES` beside it for each type's sealed limit. `pnpm --filter @trioditis/backend protocol-schema` writes it out for the bridge host:

- `apps/bridge-host/internal/protocol/events.json`, each type's required and optional fields, the values its fixed-set fields may take (statuses, error codes, kinds) and its sealed limit, which the bridge host embeds. It writes and validates every event by it, and its tests check that the statuses, error codes and login step types it declares are exactly these.
- `apps/bridge-host/internal/protocol/testdata/event-vectors.json`, example events the backend must accept and refuse, with every choice of every field that has several, and the validator itself. The gateway's tests check them against the validator. The bridge host's tests check that it sends every valid one back unchanged and never sends an invalid one.

A test fails while either file is older than the validator, and the backend doesn't compile while `@trioditis/core`'s `BridgeEvent` type differs from the validator's. So a field added on one side alone fails CI on the other.

## Commands: gateway → bridge host

`POST /v1/commands`

```json
{
  "commandId": "...",
  "type": "send",
  "userId": "...",
  "loginId": "l_...",
  "notAfter": 1732286400000
}
```

- Responds `202` once durably queued in `trioditis_command`, or `4xx` with `{"error": "<code>"}`.
- `commandId` is idempotent: duplicate submissions return `202` without re-executing.
- **Size caps:** Sealed messages/edits in events max 256 KiB (auto-truncated with `truncated: true`); chat/contact metadata and collages max 8 KiB; client outbound sends and login input max 64 KiB; login steps max 64 KiB; `hostId` max 64 chars.
- **Deadlines:** Sends carry `notAfter` (24 hours); reactions and their removals carry `notAfter` (10 minutes); login commands expire after 10 minutes (`expired`). Payloads are deleted from the host as soon as execution finishes.

| Type                | Fields                                                                                              | Outcome event                                    |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `send`              | `portalId`, `clientMessageId`, `sealed` (`outbound`), `notAfter`, `replyTo?`                        | `sendStatus`, then echoed `message`              |
| `edit`              | `portalId`, `targetEventId`, `clientMessageId`, `sealed` (`outbound`, plain text only), `notAfter?` | `sendStatus`, then `edit`                        |
| `react` / `unreact` | `portalId`, `targetEventId`, `key`, `notAfter?`                                                     | `reaction` / `reactionRemove`                    |
| `redact`            | `portalId`, `targetEventId`                                                                         | `redaction`                                      |
| `markRead`          | `portalId`, `upToEventId`                                                                           | none                                             |
| `typing`            | `portalId`, `typing`                                                                                | none                                             |
| `loginStart`        | `loginSessionId`, `network`, `flowId?`                                                              | `loginStep`                                      |
| `loginSubmit`       | `loginSessionId`, `stepId`, `sealed` (`outbound`, `<loginSessionId>/<stepId>`)                      | `loginStep`                                      |
| `loginCancel`       | `loginSessionId`                                                                                    | `loginStep` (`cancelled`)                        |
| `logout`            | —                                                                                                   | `loginState` (`LOGGED_OUT`)                      |
| `backfill`          | `portalId`, `beforeEventId?`, `limit` (1–500)                                                       | `historical: true` messages, then `backfillDone` |

### Send delivery rules

- `submitted` is emitted on connector handoff, `sent` on network confirmation, `failed` only when the network definitively refuses, and `unknown` whenever an outcome is ambiguous (including restarts mid-send). **The bridge host never retries a send automatically.**
- `notAfter` is enforced before handoff (with an 11-minute safety margin) and again when reading media attachments (2-minute margin). Past handoff to `bridgev2`, `notAfter` is best-effort—for example, a stalled WhatsApp `whatsmeow` send lock can delay transmission past `notAfter`, in which case the actual outcome (`sent` or `unknown`) is always reported truthfully. A reaction's shorter `notAfter` is checked as it stands, without the 11-minute margin, which would otherwise refuse every reaction on arrival: the host refuses a reaction or its removal that is past `notAfter` before handoff, but one handed off just before can wait on the chat's lock and reach the network after it. Its echo then updates the chat as usual.

## Error and quarantine codes

Protocol errors never contain free-text strings:

- **Error codes:** `network_rejected`, `not_connected`, `timeout`, `invalid_command`, `expired`, `unsupported`, `rate_limited`, `bad_credentials`, `login_failed`, `internal`
- **Quarantine reasons:** `missing_target`, `missing_chat`, `foreign_login`, `foreign_host`, `unknown_login_session`, `unknown_send`, `malformed_envelope`, `too_large`, `invalid_event`

## Logins and recipient keys

### Login steps

A `loginStep` event carries a `step` payload rendered generically by the client:

```json
{
  "stepId": "...",
  "type": "displayAndWait | userInput | cookies | complete | cancelled | error",
  "instructions": "...",
  "display": { "type": "qr | code | emoji | nothing", "data": "..." },
  "fields": [{ "id": "phone", "type": "phoneNumber", "name": "Phone number" }],
  "cookies": { "url": "...", "fields": [] },
  "loginId": "... (on complete)",
  "error": "... (on error)"
}
```

Displayed pairing data (QR codes, pairing codes) is scrubbed from the bridge host's journal once acknowledged by the gateway. Submitted user credentials are always sealed to `BRIDGE_PUBLIC_KEY`.

### Fetching recipient keys

`GET /v1/keys/:userId` returns:

```json
{
  "identity": { "kid": "...", "publicKey": "..." },
  "agentAccess": { "kid": "...", "publicKey": "..." },
  "agentGrantedPortals": ["p_..."]
}
```

The bridge host caches keys for 60 seconds in memory (and persists the member's identity key in its database so sealing continues if the gateway is briefly down). Users who haven't completed identity key setup receive `409`, blocking `loginStart` until keys are ready.

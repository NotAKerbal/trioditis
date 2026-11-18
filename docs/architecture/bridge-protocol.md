# Bridge host ↔ gateway protocol (v1)

The internal API between the bridge host (Go, `apps/bridge-host`) and the gateway
(Node, `apps/gateway`). Both run on the server's internal network; neither port is
exposed publicly. JSON over HTTP, authenticated with a shared bearer token
(`TRIODITIS_INTERNAL_TOKEN`).

```
bridge host ── POST /v1/events ──────────────► gateway ──► Convex
bridge host ◄── POST /v1/commands ─────────── gateway ◄── Convex outbox
bridge host ── GET  /v1/keys/:userId ────────► gateway      (recipient public keys)
```

The gateway listens on `GATEWAY_INTERNAL_ADDR` (default `127.0.0.1:8601`). Each bridge
host process has a stable `hostId` (`BRIDGE_HOST_ID`, default `<network>-1`) and listens on
its own `BRIDGE_HOST_ADDR` (default `127.0.0.1:8611` for the first network). The gateway
finds each host's address in its own configuration, `BRIDGE_HOSTS`
(`whatsapp-1=http://127.0.0.1:8611,...`), never in anything a host sends: the shared token
and command payloads only go to configured addresses, and redirects are refused.

## Identifiers

| Name              | Meaning                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `network`         | Network slug: `whatsapp`, `signal`, `gmessages`, `telegram`, `meta`, `instagram`, `discord`, `fake` |
| `userId`          | Trioditis user ID (the Convex `members` row's `userId`)                                             |
| `loginId`         | Opaque ID (`l_…`) for a bridgev2 login, unique per network. `""` until a login completes            |
| `portalId`        | Opaque ID (`p_…`) for a bridgev2 portal, unique per network. Network IDs (phone numbers) never leak |
| `eventId`         | The deterministic event ID the bridge host generates per remote message part. The dedup key         |
| `ghostId`         | Opaque ID (`g_…`) for a bridgev2 ghost (remote user), unique per network                            |
| `clientMessageId` | Client-generated ID for a send, carried end to end                                                  |

## Events: bridge host → gateway

`POST /v1/events`

```json
{
  "hostId": "whatsapp-1",
  "network": "whatsapp",
  "events": [{ "seq": 1042, "type": "message", "userId": "…", "...": "type-specific fields" }]
}
```

- `seq` increases by one per event, per bridge host, and survives restarts (it is the
  journal's row number).
- Events are delivered **in order**. The gateway responds `200 {"ackedThrough": 1042}`
  only after every event up to that sequence is committed to Convex (or quarantined).
- The bridge host resends from `ackedThrough + 1` until acknowledged. Delivery is
  at-least-once; the gateway and Convex deduplicate on `eventId` (and on `seq` per
  `hostId`).
- `ackedThrough` can be less than the last event sent: the backend stops early to stay inside
  its transaction limits. Resend from `ackedThrough + 1`.
- A batch is at most 100 events and **8 MiB** of JSON; the gateway refuses bodies over 32 MiB.
  A single event over 1 MiB is quarantined without being applied.
- A response of `409 {"expectedSeq": n}` tells the bridge host to resend from `n`;
  everything before `n` is committed.
- **Heartbeat:** on startup and every 30 seconds the bridge host posts an empty batch
  (`events: []`). It registers the host and marks it live, and the reply's `ackedThrough`
  tells a restarted host where to resume. Commands only go to hosts heard from in the last
  two minutes.
- Every event has an integer `seq` of at least 1, a `type`, `userId` and `loginId`. A batch
  that breaks this is refused with `400`. A single event the backend can't validate is
  quarantined and skipped, so it doesn't stop the events after it.

### Event types

Every event carries `seq`, `type`, `userId`, `loginId`, and `at` (bridge host time, ms).

| Type             | Fields                                                                                                              | Notes                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`        | `portalId`, `eventId`, `networkTs`, `sender`, `sealed`, `historical`, `replyTo?`, `threadRoot?`, `clientMessageId?` | `sender` is `{"self": true}` or `{"ghostId": "…"}`. `sealed` is an envelope (see `sealing.md`) with kind `message` and object ID `eventId` |
| `edit`           | `portalId`, `eventId`, `targetEventId`, `networkTs`, `sender`, `sealed`, `clientMessageId?`                         | New content for `targetEventId`, sealed with the edit's own `eventId` as object ID                                                         |
| `reaction`       | `portalId`, `eventId`, `targetEventId`, `sender`, `key`, `networkTs`                                                | `key` is the emoji, unsealed (reactions are metadata), with variation selectors removed                                                    |
| `reactionRemove` | `portalId`, `targetEventId`, `sender`, `key`                                                                        |                                                                                                                                            |
| `redaction`      | `portalId`, `targetEventId`, `sender`, `networkTs`                                                                  | Content deleted for everyone                                                                                                               |
| `receipt`        | `portalId`, `sender`, `upToEventId`, `networkTs`                                                                    | Read receipt                                                                                                                               |
| `typing`         | `portalId`, `sender`, `typing`, `timeoutMs`                                                                         | Ephemeral                                                                                                                                  |
| `chat`           | `portalId`, `kind`, `sealed`, `parentPortalId?`, `deleted?`                                                         | `kind`: `dm`, `group`, `channel`, `space`. Upsert; `sealed` holds name, topic, avatar media                                                |
| `contact`        | `ghostId`, `sealed`                                                                                                 | Upsert; `sealed` holds name, handle, avatar media                                                                                          |
| `loginState`     | `state`, `error?`                                                                                                   | bridgev2 bridge states: `CONNECTING`, `CONNECTED`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`, `UNKNOWN_ERROR`, `LOGGED_OUT`                |
| `loginStep`      | `loginSessionId`, `step`                                                                                            | A step of a login flow, see Logins                                                                                                         |
| `sendStatus`     | `clientMessageId`, `status`, `eventId?`, `error?`                                                                   | `status`: `submitted`, `sent`, `delivered`, `read`, `failed`, `unknown`                                                                    |
| `backfillDone`   | `portalId`, `direction`, `more`                                                                                     | History import progress                                                                                                                    |

## Commands: gateway → bridge host

`POST /v1/commands`

```json
{ "commandId": "…", "type": "send", "userId": "…", "loginId": "…", "notAfter": 0, "...": "type-specific fields" }
```

`loginId` is absent for the commands of a login that isn't established yet (`loginStart`,
`loginSubmit`, `loginCancel`); they name it by `loginSessionId`. `notAfter` is on every send
and on login commands, and may be on others.

- The bridge host responds `202` once the command is durably queued, or `4xx` with
  `{"error": "<code>"}` if it is invalid. Outcomes arrive later as events.
- `commandId` is idempotent: repeating a command ID returns `202` without running it
  again. A command that may already have reached a host is only ever delivered again to
  that same host, whose journal knows its ID.
- **Ownership:** once a host is running a login, only it may send events for that login
  (a login moves to another host only through a newer `CONNECTED` report). A login's steps
  are accepted only from the host its start command was handed to.
- **Sizes:** a sealed message or edit in an event may be at most 256 KiB; files travel
  separately. Chat and contact metadata (`chat`, `contact`) may be at most **8 KiB** sealed:
  a name, a topic and an avatar's file reference. Anything over the limit is quarantined as
  `too_large`, so the bridge host measures what it seals (JSON escaping can make text several
  times longer): longer metadata has its topic (a contact's handle), then its name, cut to
  fit. A message or edit over 256 KiB loses its formatted body, then has its body cut short
  at a character boundary, and its plaintext says `truncated: true`. No event the bridge host
  sends is over 1 MiB of JSON; a journal event from an older host that is goes as a stand-in
  with only `seq`, `type`, `userId`, `loginId` and `at`, which the gateway quarantines, so
  it can't hold up the events after it.
  A login step may be at most 64 KiB (UTF-8), and a `hostId` at most 64 characters.
  Clients may seal at most 64 KiB into a send or login input.
- **Routing:** a command for a connected login goes to the host that reported that login's
  state; a new login goes to the network's most recently seen host. Only hosts in the
  gateway's `BRIDGE_HOSTS` and heard from recently are used.
- **Deadlines:** sends carry `notAfter` (24 hours). Login commands carry one too, 10 minutes
  out: undelivered by then, they expire, ending the login with error `expired`, so
  credentials don't wait for a host that never returns. How far the bridge host can enforce
  a send's deadline is under Delivery rules for `send`.
- A status or echo for a send proves the host has the command, even if its `202` was lost;
  the backend then never delivers it again.
- Once a command has run (sent, failed or expired), the bridge host keeps only its IDs and
  status, never its payload.

| Type                | Fields                                                                                                                                 | Outcome event                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `send`              | `portalId`, `clientMessageId`, `sealed` (kind `outbound`, object ID `clientMessageId`), `notAfter`, `replyTo?`                         | `sendStatus`, then `message` with the same `clientMessageId`  |
| `edit`              | `portalId`, `targetEventId`, `clientMessageId`, `sealed` (kind `outbound`, object ID `clientMessageId`), `notAfter?`                   | `sendStatus`, then `edit`                                     |
| `react` / `unreact` | `portalId`, `targetEventId`, `key`                                                                                                     | `reaction` / `reactionRemove`                                 |
| `redact`            | `portalId`, `targetEventId`                                                                                                            | `redaction`                                                   |
| `markRead`          | `portalId`, `upToEventId`                                                                                                              | none                                                          |
| `typing`            | `portalId`, `typing`                                                                                                                   | none                                                          |
| `loginStart`        | `loginSessionId`, `network`, `flowId?`                                                                                                 | `loginStep`                                                   |
| `loginSubmit`       | `loginSessionId`, `stepId`, `sealed` (kind `outbound`, object ID `<loginSessionId>/<stepId>`, plaintext `{"input": {fieldId: value}}`) | `loginStep`                                                   |
| `loginCancel`       | `loginSessionId`                                                                                                                       | `loginStep` (cancelled)                                       |
| `logout`            |                                                                                                                                        | `loginState` (`LOGGED_OUT`)                                   |
| `backfill`          | `portalId`, `beforeEventId?`, `limit`                                                                                                  | `message` events with `historical: true`, then `backfillDone` |

### Command validation

- `send` needs `notAfter`; without it the command is refused (`400 invalid_command`).
- A `send` or `edit` whose `sealed` holds more than 64 KiB (the client limit, see Sizes) is
  refused (`400 invalid_command`) before it runs: only a client's outbox may send, and the
  backend never accepts more from a client.
- Targets must be bridged messages in the command's own chat: `replyTo`, `targetEventId`
  (edit, react, unreact, redact), `upToEventId` (markRead) and `beforeEventId` (backfill).
  A `pending:` ID, a deleted message or a message from another chat is refused
  (`409 invalid_command`).
- Backfill `limit` is 1 to 500. A network whose connector can't import a bounded range
  without pruning history it hasn't imported (WhatsApp, for now) answers an explicit
  `backfill` with `409 unsupported`; its history arrives through the connector's own sync.
- A repeated `commandId` always gets `202`, even if checking it again would now fail: it was
  accepted once.
- A command accepted with `202` that then fails when run is reported as a send `failed`, or
  a login step of type `error`.
- After a restart, an interrupted `loginStart` or `loginSubmit` ends with a login step of type
  `error` (`internal` or `login_failed`); a send handed to the network but not recorded ends
  `unknown`.

### Delivery rules for `send`

- The bridge host emits `submitted` when it hands the message to the network connector,
  `sent` when the network confirms, and `failed` with an error when the network refuses.
- If the outcome is ambiguous (the connector returns an error after the network may
  have accepted the message, or the bridge host restarted mid-send), it emits `unknown`.
  **It never retries a send on its own.**
- A `send` whose `clientMessageId` the bridge host has already seen is not sent again;
  the bridge host re-emits the last known `sendStatus`.
- `notAfter` (ms since the epoch) is **best effort**, not a hard deadline, for any send
  handed to bridgev2, and for WhatsApp sends in Phase 0 in particular. The bridge host checks
  it when the send starts and again as its last step before handing the send to bridgev2,
  both with an 11-minute margin for what bridgev2 may still wait on, and once more, with a
  2-minute margin, if the connector reads the send's attachment (the last code of the bridge
  host's that runs before a media send is uploaded and transmitted). A send refused at any
  of these never reaches the network: the bridge host emits `failed` with error `expired`,
  and the person decides. So a send can be refused as `expired` before `notAfter`.
- **Limit:** past those checks the bridge host can't stop a send, and it can go out after
  `notAfter`, by any amount. bridgev2 calls the connector with its own context, which
  carries no deadline, and for a text send no code of the bridge host's runs between the
  hand-off and the transmission. What can delay it: waiting behind more than two incoming
  events that each hit bridgev2's 5-minute handler limit, a slow media upload, and
  (WhatsApp) whatsmeow's send lock. That lock is one per login: every send in all of the
  person's chats takes it in turn, and holds it until the server acknowledges the message.
  The first wait for that acknowledgement is 75 seconds, but if the connection drops first,
  whatsmeow sends the frame again after reconnecting and then waits for its
  acknowledgement **with no time limit**, still holding the lock. If the new connection stays
  open and that acknowledgement never comes, every send on the login waits indefinitely
  (until the chat is deleted, the login disconnects again, or the bridge host stops), and a
  send waiting behind it is transmitted, after `notAfter`, once the lock clears. A late
  transmission is reported as what happened, never as `expired`: `sent` if the network
  confirms it while the bridge host still remembers the send (even after it was marked
  `unknown`, for up to an hour after its chat was released without an outcome), and
  otherwise `unknown`. Closing this needs a pre-send hook in bridgev2 or the connector, and a bounded
  retransmit wait in whatsmeow (bridge host README, Known follow-ups).

## Errors

Every `error` (in `sendStatus`, `loginState`, a login step, or a `4xx` body) is one of
these codes, never free text: a connector's message can quote what the person typed.

`network_rejected`, `not_connected`, `timeout`, `invalid_command`, `expired`,
`unsupported`, `rate_limited`, `bad_credentials`, `login_failed`, `internal`

Connector error details are logged locally by the bridge host only, without content.

Events the backend can't apply are quarantined with a reason code (`missing_target`,
`missing_chat`, `foreign_login`, `foreign_host`, `unknown_login_session`, `unknown_send`,
`malformed_envelope`, `too_large`, `invalid_event`), never with their content.

## Logins

Logins follow bridgev2's login steps. A `loginStep` event's `step`:

```json
{
  "stepId": "…",
  "type": "displayAndWait | userInput | cookies | complete | cancelled | error",
  "instructions": "…",
  "display": { "type": "qr | code | emoji | nothing", "data": "…" },
  "fields": [{ "id": "phone", "type": "phoneNumber", "name": "Phone number" }],
  "cookies": { "url": "…", "fields": [] },
  "loginId": "… (on complete)",
  "error": "… (on error)"
}
```

The app renders every network's login from these steps; there is no per-network login
UI.

Pairing data shown to the person (a QR code, a pairing code) is scrubbed from the bridge
host's journal once the gateway has acknowledged the step, so a replay of that step has an
empty `display.data`.

What a person types or pastes into a login step (phone numbers, codes, cookies) is a
credential. The client seals it to the bridge key, so the outbox never holds it in
plaintext; the bridge host opens it, uses it and discards it.

## Bridge key

The bridge host's X25519 key pair, `BRIDGE_PRIVATE_KEY` and `BRIDGE_PUBLIC_KEY`
(base64url). Clients seal outbound sends and login input to the public key, which the
backend serves to signed-in clients. Every bridge host process on a server shares it.

## Recipient keys: bridge host → gateway

`GET /v1/keys/:userId` returns the public keys to seal a person's objects to:

```json
{
  "identity": { "kid": "…", "publicKey": "…" },
  "agentAccess": { "kid": "…", "publicKey": "…" },
  "agentGrantedPortals": ["…"]
}
```

The bridge host caches the response for 60 seconds. A person with no identity key yet
(signed up but not finished device setup) gets `409`, and `loginStart` for them is
refused, so no network events can exist for someone the bridge host can't seal to.

The bridge host's journal stores events **after** sealing: the bridge host itself never
writes plaintext content to its journal or its own tables. The network connectors' own
storage, in the same database, is the exception: bridgev2's chat and contact tables, and for
WhatsApp its history-sync table and whatsmeow's decrypted-event buffer, which holds an
incoming message's plaintext until it is journaled and, after a failure, for up to about 14
days. See `sealing.md`, What else is stored in plaintext, and the bridge host README,
Plaintext at rest.

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
{ "commandId": "…", "type": "send", "userId": "…", "loginId": "…", "...": "type-specific fields" }
```

- The bridge host responds `202` once the command is durably queued, or `4xx` with
  `{"error": "<code>"}` if it is invalid. Outcomes arrive later as events.
- `commandId` is idempotent: repeating a command ID returns `202` without running it
  again. A command that may already have reached a host is only ever delivered again to
  that same host, whose journal knows its ID.
- **Ownership:** once a host is running a login, only it may send events for that login
  (a login moves to another host only through a newer `CONNECTED` report). A login's steps
  are accepted only from the host its start command was handed to.
- **Sizes:** a sealed object in an event may be at most 512 KiB; files travel separately.
  Clients may seal at most 64 KiB into a send or login input.
- **Routing:** a command for a connected login goes to the host that reported that login's
  state; a new login goes to the network's most recently seen host. Only hosts in the
  gateway's `BRIDGE_HOSTS` and heard from recently are used.
- **Deadlines:** sends carry `notAfter` (24 hours). Login commands expire after 10 minutes
  undelivered, ending the login with error `expired`, so credentials don't wait for a host
  that never returns.
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

### Delivery rules for `send`

- The bridge host emits `submitted` when it hands the message to the network connector,
  `sent` when the network confirms, and `failed` with an error when the network refuses.
- If the outcome is ambiguous (the connector returns an error after the network may
  have accepted the message, or the bridge host restarted mid-send), it emits `unknown`.
  **It never retries a send on its own.**
- A `send` whose `clientMessageId` the bridge host has already seen is not sent again;
  the bridge host re-emits the last known `sendStatus`.
- A `send` not handed to the network by `notAfter` (ms since the epoch) is never sent:
  the bridge host emits `failed` with error `expired`, and the person decides.

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

The bridge host's journal stores events **after** sealing. Plaintext content is never
written to disk.

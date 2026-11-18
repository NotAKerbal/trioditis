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
host process listens on its own `BRIDGE_HOST_ADDR` (default `127.0.0.1:8611` for the first
network) and tells the gateway its address in every event batch.

## Identifiers

| Name              | Meaning                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `network`         | Network slug: `whatsapp`, `signal`, `gmessages`, `telegram`, `meta`, `instagram`, `discord`, `fake` |
| `userId`          | Trioditis user ID (the Convex `members` row's `userId`)                                             |
| `loginId`         | bridgev2 `UserLoginID`, unique per network                                                          |
| `portalId`        | bridgev2 portal key, `"<id>"` or `"<id>/<receiver>"`, unique per network                            |
| `eventId`         | The deterministic event ID the bridge host generates per remote message part. The dedup key         |
| `ghostId`         | bridgev2 ghost (remote user) ID, unique per network                                                 |
| `clientMessageId` | Client-generated ID for a send, carried end to end                                                  |

## Events: bridge host → gateway

`POST /v1/events`

```json
{
  "hostId": "whatsapp-1",
  "network": "whatsapp",
  "commandAddr": "http://127.0.0.1:8611",
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
- A response of `409 {"expectedSeq": n}` tells the bridge host to resend from `n`.

### Event types

Every event carries `seq`, `type`, `userId`, `loginId`, and `at` (bridge host time, ms).

| Type             | Fields                                                                                                              | Notes                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`        | `portalId`, `eventId`, `networkTs`, `sender`, `sealed`, `historical`, `replyTo?`, `threadRoot?`, `clientMessageId?` | `sender` is `{"self": true}` or `{"ghostId": "…"}`. `sealed` is an envelope (see `sealing.md`) with kind `message` and object ID `eventId` |
| `edit`           | `portalId`, `eventId`, `targetEventId`, `networkTs`, `sender`, `sealed`                                             | New content for `targetEventId`                                                                                                            |
| `reaction`       | `portalId`, `eventId`, `targetEventId`, `sender`, `key`, `networkTs`                                                | `key` is the emoji, unsealed (reactions are metadata)                                                                                      |
| `reactionRemove` | `portalId`, `targetEventId`, `sender`, `key`                                                                        |                                                                                                                                            |
| `redaction`      | `portalId`, `targetEventId`, `sender`, `networkTs`                                                                  | Content deleted for everyone                                                                                                               |
| `receipt`        | `portalId`, `sender`, `upToEventId`, `networkTs`                                                                    | Read receipt                                                                                                                               |
| `typing`         | `portalId`, `sender`, `typing`, `timeoutMs`                                                                         | Ephemeral                                                                                                                                  |
| `chat`           | `portalId`, `kind`, `sealed`, `parentPortalId?`, `deleted?`                                                         | `kind`: `dm`, `group`, `channel`, `space`. Upsert; `sealed` holds name, topic, avatar media                                                |
| `contact`        | `ghostId`, `sealed`                                                                                                 | Upsert; `sealed` holds name, handle, avatar media                                                                                          |
| `loginState`     | `state`, `error?`, `message?`                                                                                       | bridgev2 bridge states: `CONNECTING`, `CONNECTED`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`, `UNKNOWN_ERROR`, `LOGGED_OUT`                |
| `loginStep`      | `loginSessionId`, `step`                                                                                            | A step of a login flow, see Logins                                                                                                         |
| `sendStatus`     | `clientMessageId`, `status`, `eventId?`, `error?`                                                                   | `status`: `submitted`, `sent`, `delivered`, `read`, `failed`, `unknown`                                                                    |
| `backfillDone`   | `portalId`, `direction`, `more`                                                                                     | History import progress                                                                                                                    |

## Commands: gateway → bridge host

`POST /v1/commands`

```json
{ "commandId": "…", "type": "send", "userId": "…", "loginId": "…", "...": "type-specific fields" }
```

- The bridge host responds `202` once the command is durably queued, or `4xx` with
  `{"error": "…"}` if it is invalid. Outcomes arrive later as events.
- `commandId` is idempotent: repeating a command ID returns `202` without running it
  again.

| Type                | Fields                                                                                                                                 | Outcome event                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `send`              | `portalId`, `clientMessageId`, `sealed` (kind `outbound`, object ID `clientMessageId`), `replyTo?`                                     | `sendStatus`, then `message` with the same `clientMessageId`  |
| `edit`              | `portalId`, `targetEventId`, `clientMessageId`, `sealed`                                                                               | `sendStatus`, then `edit`                                     |
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

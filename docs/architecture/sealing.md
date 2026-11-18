# Sealing

How Trioditis stores message content so the operator can't read it. This is the
contract the TypeScript (`packages/crypto`) and Go (`apps/bridge-host`)
implementations both follow. The two are tested against shared vectors in
`packages/crypto/testdata/vectors.json`.

## Goal and limits

Stored content (message bodies, attachments, chat and contact metadata, drafts) is
readable only by its owner's devices and by agents the owner grants. The server can
**encrypt** to a person but cannot **decrypt** what it stored.

The bridge host still sees plaintext as a message passes through, and holds each
person's network sessions. Sealing protects stored history, backups and database
dumps; it does not protect against an operator who modifies the running server. See
`docs/PLAN.md`, Sealed storage.

## Why not per-chat keys

An earlier draft gave each chat a symmetric key wrapped to its owner. The bridge host
would then need that chat key in the clear to encrypt incoming messages, which means
the server could also decrypt everything in the chat. Instead, every sealed object gets
its own random **content key**, and only the content key is sealed to each recipient's
public key. The server forgets the content key as soon as it has sealed it.

## Keys

| Key                   | Type            | Held by                                                                                                          |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Identity key pair     | X25519          | Each person. Private key only on their devices, wrapped by a passkey- or password-derived key and a recovery key |
| Agent-access key pair | X25519          | The server (the MCP server decrypts granted chats for agents)                                                    |
| Bridge key pair       | X25519          | The bridge host (clients encrypt outgoing messages to it)                                                        |
| Content key           | 32 random bytes | Nobody, after sealing                                                                                            |

A **key ID** (`kid`) is the first 16 bytes of `BLAKE2b-256(publicKey)`, base64url
without padding.

## Envelope v1

```json
{
  "v": 1,
  "nonce": "<24 bytes, base64url>",
  "ct": "<ciphertext + 16-byte tag, base64url>",
  "keys": [{ "kid": "<key ID>", "sk": "<sealed content key, base64url>" }]
}
```

- **Content:** `XChaCha20-Poly1305` (IETF) with the content key, a random 24-byte nonce,
  and the associated data below. The plaintext is UTF-8 JSON.
- **Recipients:** for each recipient, the content key sealed with libsodium's
  `crypto_box_seal` (X25519, XSalsa20-Poly1305, anonymous sender). Go uses
  `golang.org/x/crypto/nacl/box.SealAnonymous`, which is compatible.
- **Associated data:** `trioditis/v1/<kind>/<ownerUserId>/<objectId>` as UTF-8. It binds
  ciphertext to the row it belongs to, so the server can't swap one message's
  ciphertext into another without decryption failing.
- **Encoding:** base64url without padding for every binary field.

`kind` is one of `message`, `chat`, `contact`, `draft`, `outbound`, `media`, `label`. The object ID
for each:

| Object                              | Kind       | Object ID                   |
| ----------------------------------- | ---------- | --------------------------- |
| A message                           | `message`  | its `eventId`               |
| An edit                             | `message`  | the edit's own `eventId`    |
| The person's pending copy of a send | `message`  | its `clientMessageId`       |
| Chat metadata                       | `chat`     | `portalId`                  |
| A contact                           | `contact`  | `ghostId`                   |
| A `send` or `edit` command          | `outbound` | its `clientMessageId`       |
| Login input                         | `outbound` | `<loginSessionId>/<stepId>` |
| A file                              | `media`    | its `mediaId`               |
| A label (name and colour)           | `label`    | its `labelKey`              |

## Recipients

| Object                                                     | Recipients                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Incoming message, chat or contact metadata                 | The owner's identity key, plus the agent-access key if the chat is granted to an agent |
| Message the person sent from Trioditis (their stored copy) | Same as above                                                                          |
| Outbound send (`outbound`)                                 | The bridge key only                                                                    |
| Draft                                                      | The owner's identity key only                                                          |

**Granting** an agent access to a chat's history: the person's device unseals each
message's content key and re-seals it to the agent-access key, adding a `keys` entry.
Content is not re-encrypted. Messages arriving after the grant include the agent-access
key from the start. **Revoking** removes the agent-access entries.

## Media

Each file is encrypted with its own random key, `XChaCha20-Poly1305` with associated
data `trioditis/v1/media/<ownerUserId>/<mediaId>`, in one piece for Phase 0 (chunked
streaming encryption is a later change behind the same envelope version bump). The
file's key and nonce travel inside the sealed message plaintext, never alongside the
file.

## Message plaintext (v1)

```json
{
  "type": "text | notice | emote | image | video | audio | file | sticker | location",
  "body": "plain text",
  "html": "optional formatted body, sanitized on render",
  "attachments": [
    {
      "mediaId": "…",
      "mime": "image/jpeg",
      "size": 12345,
      "name": "photo.jpg",
      "key": "<base64url>",
      "nonce": "<base64url>",
      "width": 800,
      "height": 600,
      "durationMs": 0
    }
  ],
  "mentions": ["<contact id>"],
  "truncated": true
}
```

`truncated` is set only when the bridge host cut a message down to fit the 256 KiB sealed
limit (see bridge-protocol.md, Sizes): its `html` was dropped and its `body` may end early.

Chat and contact metadata carry their avatar as an attachment (with its key and nonce)
in `avatar`, for the same reason. When the avatar is unchanged but the bridge host can't
include it this time, the metadata says `avatarUnchanged: true` instead, and clients keep
the avatar they have (a device seeing the chat for the first time has none until it
changes).

Unknown fields are preserved by readers, so newer writers can add fields without a
version bump.

## Bridge key exposure

Anything sealed to the bridge key (outbound sends, login input) can be opened by whoever
holds `BRIDGE_PRIVATE_KEY`. So those payloads are kept only until the bridge host has them:
the backend deletes its copy as soon as the bridge host accepts the command (or it is
rejected or expires), and the bridge host keeps only IDs and status once it has run it. A
backup therefore holds only commands in flight at that moment. Rotating the bridge key is a
later addition.

## What else is stored in plaintext

The network connectors keep their own state in the bridge host's database, and some of it
is plaintext the operator could read with database access: bridgev2's portal, ghost and
login tables (chat names, contact names, phone numbers), WhatsApp's history-sync table (raw
history until it is imported), whatsmeow's contacts, and whatsmeow's decrypted-event buffer
(`whatsmeow_event_buffer`). That buffer holds each incoming WhatsApp message's decrypted
protobuf (content included) from decryption until its handler returns success, and
whatsmeow then clears the plaintext. That is normally once the bridge host has journaled it
sealed (usually moments), but bridgev2 also reports success when its 5-minute handler limit
passes, while handling carries on (see below). It is kept on purpose: a message can be decrypted only once, so without it a
crash mid-message would lose that message. Plaintext stays in a row only when:

- handling failed, or the process stopped before it finished: the message wasn't
  acknowledged, so WhatsApp redelivers it, and the buffered copy is bridged and cleared then;
- clearing the plaintext failed with a database error: whatsmeow still acknowledges the
  message, so no redelivery clears it.

Either way the row is deleted, plaintext and all, by the first sweep that succeeds once it
is about 14 days old (WhatsApp's redelivery window); the bridge host sweeps at start-up and
hourly, and a sweep that fails leaves the row for the next. One case loses a message rather than
keeping it: after bridgev2's 5-minute handler limit it reports success while handling
carries on in the background, so whatsmeow clears the plaintext and acknowledges the
message; if the process stops before the sealed event is journaled, WhatsApp doesn't
redeliver it. See the bridge host README, Plaintext at rest.

**Phase 0:** that database, the event buffer included, lives on an **encrypted disk, with
encrypted backups**; the installer warns when its data directory isn't on an encrypted
volume. **Phase 1:** those columns are sealed with a server-held key. See docs/PLAN.md, Open questions.

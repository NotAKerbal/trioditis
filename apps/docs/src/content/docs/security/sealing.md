---
title: Sealed Storage Spec
description: Cryptographic contract (v1) shared by packages/crypto (TypeScript) and apps/bridge-host (Go).
---

This document specifies how Trioditis encrypts stored content so the server can **encrypt** incoming data to a member without ever being able to **decrypt** what it stored.

Both the TypeScript implementation (`packages/crypto`) and the Go implementation (`apps/bridge-host/internal/seal`) implement this contract and cross-verify against shared test vectors in `packages/crypto/testdata/vectors.json` and `vectors-go.json`.

## Why per-object content keys?

Instead of per-chat symmetric keys (which the bridge host would have to hold in plaintext to encrypt incoming messages—letting the server read the whole chat), every sealed object receives a fresh 32-byte random **content key**. Only that content key is sealed to each recipient's X25519 public key, and the bridge host discards the content key immediately afterward.

## Keys

| Key                       | Algorithm / Size | Held by                                                                                               |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| **Identity key pair**     | X25519           | Each member; private key exists only on their devices (wrapped by password, recovery key, or passkey) |
| **Agent-access key pair** | X25519           | The server (allows the MCP server to decrypt chats explicitly granted to an agent)                    |
| **Bridge key pair**       | X25519           | The bridge host (clients seal outbound sends and login credentials to its public key)                 |
| **Content key**           | 32 random bytes  | Discarded immediately after sealing                                                                   |

A **key ID (`kid`)** is the first 16 bytes of `BLAKE2b-256(publicKey)`, encoded as unpadded base64url.

## Envelope v1

```json
{
  "v": 1,
  "nonce": "<24 bytes, base64url>",
  "ct": "<ciphertext + 16-byte tag, base64url>",
  "keys": [{ "kid": "<key ID>", "sk": "<sealed content key, base64url>" }]
}
```

- **Cipher:** `XChaCha20-Poly1305` (IETF) using the 32-byte content key, a random 24-byte nonce, and the associated data below. Plaintext is UTF-8 JSON.
- **Key wrapping:** Each recipient entry seals the content key using libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305, anonymous sender). Go uses the compatible `golang.org/x/crypto/nacl/box.SealAnonymous`.
- **Associated data (AAD):** `trioditis/v1/<kind>/<ownerUserId>/<objectId>` as UTF-8 bytes. This cryptographically binds each ciphertext to its exact row so ciphertexts cannot be transplanted between rows or accounts.
- **Encoding:** Unpadded base64url for all binary fields.

### Object kinds and IDs

| Object                            | `kind`     | `objectId`                  |
| --------------------------------- | ---------- | --------------------------- |
| Incoming or echoed message        | `message`  | `eventId`                   |
| Message edit                      | `message`  | The edit's own `eventId`    |
| Pending copy of a send            | `message`  | `clientMessageId`           |
| Chat metadata                     | `chat`     | `portalId`                  |
| Contact profile                   | `contact`  | `ghostId`                   |
| Outbound `send` or `edit` command | `outbound` | `clientMessageId`           |
| Login step input                  | `outbound` | `<loginSessionId>/<stepId>` |
| Media attachment                  | `media`    | `mediaId`                   |
| Label (name & color)              | `label`    | `labelKey`                  |

## Recipient matrix

| Object                                           | Sealed to                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Incoming message, chat metadata, contact profile | Owner's identity key (+ agent-access key if chat is granted to an agent) |
| Member's own stored copy of a sent message       | Same as above                                                            |
| Outbound send or login input (`outbound`)        | Bridge key only                                                          |
| Draft or label                                   | Owner's identity key only                                                |

**Granting an agent access to history:** The member's device unseals each message's content key and re-seals it to the agent-access public key, appending an entry to `keys` without re-encrypting the message body. New messages include the agent-access key automatically. Revoking a grant strips those `keys` entries.

## Media encryption

Each attachment is encrypted as a single `XChaCha20-Poly1305` blob (chunked streaming encryption is planned behind an envelope version bump) with its own random key, nonce, and AAD `trioditis/v1/media/<ownerUserId>/<mediaId>`. The file's `key` and `nonce` travel exclusively inside the sealed message plaintext—never stored beside the encrypted blob.

## Message plaintext schema (v1)

```json
{
  "type": "text | notice | emote | image | video | audio | file | sticker | location",
  "body": "plain text",
  "html": "optional formatted body, sanitized on render",
  "attachments": [
    {
      "mediaId": "...",
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

- `truncated` is set only when the bridge host had to trim an oversized message to stay within the 256 KiB sealed envelope limit (`html` dropped first, then `body` cut on a UTF-8 character boundary).
- Chat and contact metadata carry their avatar in an `avatar` attachment field. If an avatar hasn't changed and its temporary upload expired, the metadata sets `avatarUnchanged: true` so clients keep their cached copy.
- A group's collage (the members whose pictures make its picture when it has none) is sealed apart from its metadata in a `chatCollage` event: kind `chat`, object ID `<portalId>/collage`, plaintext `{"ghosts": [...]}`, to the person only. Apart, because bridgev2 changes a chat's name, picture and members in one go and saves the chat after, so describing the chat again for its members could send a name or picture being replaced. It names up to four opaque ghost IDs, never the person's, those with a picture first, in a fixed order. Clients draw each from that contact's profile, so a member's new picture needs no new collage. The bridge host chooses again on joins and leaves, when a member's picture is set or removed, and at each start, and sends it only when the choice changed (the last one sent is kept as opaque IDs in `trioditis_collage`).
- Readers preserve unknown fields so future writers can extend schemas cleanly.

## Bridge key exposure & payload lifetimes

Payloads sealed to the bridge key (`outboxPayloads`) can be opened by anyone holding both the ciphertext and `BRIDGE_PRIVATE_KEY`. To minimize exposure:

1. **Separated from backups:** `deploy/trioditis backup` omits `BRIDGE_PRIVATE_KEY` and `AGENT_ACCESS_PRIVATE_KEY` from `secrets.env`; keys are exported separately via `deploy/trioditis keys export`.
2. **Ephemeral retention:** The backend deletes each `outboxPayloads` row as soon as the bridge host accepts or rejects the command, or automatically via a scheduled deadline job at `notAfter` (24 hours for sends, 10 minutes for login credentials). Once executed, the bridge host retains only IDs and status.
3. **Scheduled sends (accepted exception):** A scheduled message's bridge-sealed copy (`scheduledPayloads`, up to 365 days ahead) stays stored until `sendAt`, `scheduled.sendNow`, cancellation, or chat deletion so scheduled messages dispatch on time even when all of your devices are offline.

## Connector plaintext at rest

While the bridge host's own tables and journal never store plaintext content, upstream `bridgev2` connectors keep operational state in the shared PostgreSQL database:

- `portal`, `ghost`, and `user_login` tables (chat names, contact names, phone numbers)
- `whatsapp_history_sync_message` (raw WhatsApp history batches until imported and deleted)
- `whatsmeow_event_buffer` (decrypted incoming WhatsApp protobufs kept briefly so a crash mid-handler doesn't lose a single-decryption Signal message; cleared once handled or swept after 14 days by `internal/wabuffer`)

For this reason, Trioditis requires **encrypted disk storage and encrypted backups** for the server (see [Encryption at rest](/self-hosting/backup-and-keys/#encryption-at-rest)). Server-key sealing of these connector columns is planned for Phase 1.

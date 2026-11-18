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

| Key | Type | Held by |
|---|---|---|
| Identity key pair | X25519 | Each person. Private key only on their devices, wrapped by a passkey- or password-derived key and a recovery key |
| Agent-access key pair | X25519 | The server (the MCP server decrypts granted chats for agents) |
| Bridge key pair | X25519 | The bridge host (clients encrypt outgoing messages to it) |
| Content key | 32 random bytes | Nobody, after sealing |

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

`kind` is one of `message`, `chat`, `contact`, `draft`, `outbound`, `media`.

## Recipients

| Object | Recipients |
|---|---|
| Incoming message, chat or contact metadata | The owner's identity key, plus the agent-access key if the chat is granted to an agent |
| Message the person sent from Trioditis (their stored copy) | Same as above |
| Outbound send (`outbound`) | The bridge key only |
| Draft | The owner's identity key only |

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
  "mentions": ["<contact id>"]
}
```

Unknown fields are preserved by readers, so newer writers can add fields without a
version bump.

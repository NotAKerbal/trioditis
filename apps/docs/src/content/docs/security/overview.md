---
title: Security Model
description: Understand Trioditis's threat model, what sealed storage protects, where plaintext exists, and how clients and servers are hardened.
---

Trioditis is designed so a server operator can host, administer, and back up an instance for a household or group without being able to read anyone's stored conversations.

## What is sealed vs. visible to the server

Every member has an **X25519 identity key pair** whose private key never leaves their devices (wrapped at rest by their password, recovery key, and optionally a passkey). Stored objects are encrypted using per-object random content keys—see the [Sealed Storage Spec](/security/sealing/) for the cryptographic details.

| Sealed (encrypted to the member)                                             | Visible to the server                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Message bodies, formatted HTML, attachments, link previews                   | Message IDs, timestamps, opaque sender IDs, delivery state                  |
| Media files (encrypted per file; key & nonce live inside the sealed message) | File sizes, MIME content types                                              |
| Chat names, avatars, topics                                                  | Network slug, chat kind, unread counts, pinned/archived/muted/snoozed flags |
| Contact names, handles, avatars                                              | Opaque contact IDs (`g_...`)                                                |
| Label names & colors, drafts                                                 | Label/draft existence                                                       |

## The bridge host trust boundary

Be honest about what any bridge-based system can and cannot guarantee:

- **Inbound:** Each messaging platform's transport encryption terminates at the bridge host on the operator's server. The bridge host seals each incoming message to its owner's public key before writing it to its durable journal, then discards the content key. Convex and the gateway only ever see ciphertext.
- **Outbound:** The client seals outgoing messages to the bridge host's public key. The bridge host decrypts the send, re-encrypts it using the destination platform's protocol (for example, WhatsApp end-to-end encryption), transmits it, and deletes the payload.
- **What sealing protects:** Stored message history in Convex, database dumps, server backups, and casual inspection by the operator.
- **What sealing cannot protect against:** An active operator who modifies the running bridge host binary or intercepts live traffic in memory, since the bridge host must hold each user's platform session keys and process plaintext during bridging. Trioditis states this plainly when invited members join and when connecting a network.
- **Key loss:** Losing all signed-in devices **and** the recovery key permanently loses access to sealed history. Network accounts can still be re-linked and history re-imported where the network permits.

## Password and session security

- **Passwords never reach the server:** Clients derive a sign-in credential via `authPassword(password, email)` (Argon2id + BLAKE2b-256) for Better Auth and separately derive a stronger wrapping key (`passwordKey`, Argon2id with a random salt, 64 MiB / 3 passes) to unwrap the identity key backup.
- **Same-origin authentication:** Auth routes (`/api/auth/*`) are served on the app's own origin through Caddy (or Vite in dev). Cookies and WebAuthn passkeys are strictly first-party, and cross-origin auth is disabled.
- **Session-bound sensitive writes:** Key setup, backup updates, password changes, network logins, label creation, invites, and agent authorizations bind to the page's Better Auth `sessionId` so switching accounts in another browser tab can never write data to the wrong member.
- **Persistent rate limiting:** Auth endpoints are protected by token-bucket rate limits stored in Convex (`rateLimits`), keyed by SHA-256 hashes of client IP (from Caddy's overwritten `X-Trioditis-Client-IP`) and email.

## Server and client hardening

- **Minimal network exposure:** Only Caddy publishes external ports. PostgreSQL, Convex, the gateway, and every bridge host live strictly on an internal Docker network. Convex telemetry is disabled (`DISABLE_BEACON`).
- **Strict authorization:** Every Convex query, mutation, media fetch, and MCP tool call verifies that the caller owns the data or holds an active grant for it, returning the same error for unauthorized and nonexistent rows.
- **Error hygiene:** Bridge protocol errors and quarantined events use fixed error codes—never free-text connector error strings that might echo message content.
- **Client hardening:** Message HTML is rendered exclusively through a sanitized AST. On desktop (Electron), sandboxing, context isolation, and a strict Content Security Policy apply, and local caches are encrypted with a device key.
- **Agent isolation:** External AI agents start with zero chat access. Granting read access to a chat re-seals its content keys to the server's agent-access key (clearly disclosed on the consent screen), and revoking removes those recipient entries. Outbound agent sends require human approval bound to a hash of the exact payload, recipient, and attachments.
- **Disappearing and view-once messages:** Expiry timers are enforced across Convex, local device caches, and local search indexes so expired messages are omitted from subsequent backups.

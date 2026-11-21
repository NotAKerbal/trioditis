---
title: WhatsApp
description: Implementation status, login flows, supported features, known limits, and plaintext notes for WhatsApp.
---

WhatsApp runs through `go.mau.fi/mautrix-whatsapp` (`v0.2611.0`) and `whatsmeow` as a linked companion device alongside your phone.

| Property           | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| **Network ID**     | `whatsapp`                                                     |
| **Maturity**       | **Stable**                                                     |
| **Terms risk**     | No (uses WhatsApp's official multi-device linked-device flow)  |
| **Operator setup** | None                                                           |
| **New chats from** | Existing contacts or phone numbers (`contacts.sync` supported) |

## Implementation status

WhatsApp is Trioditis's primary and most mature network:

- **Implemented:** QR code and phone pairing-code logins, DMs and groups, split per-user portals (two server members in the same group keep separate sealed copies), self-sent message attribution, replies, edits, reactions, deletions, read receipts, typing indicators, media attachments, contact syncing, starting new chats by phone number, link-time history backfill via `BatchSend`, and hourly `whatsmeow_event_buffer` sweeping.
- **Default local dev network:** `pnpm dev` runs the WhatsApp bridge host out of the box.

## How to connect

1. In Trioditis, ensure WhatsApp is installed under **Admin settings → Networks**.
2. Open **Settings → Accounts → WhatsApp** and pick either flow:
   - **Scan a QR code (`qr`):** Open WhatsApp on your phone → **Settings → Linked devices → Link a device** and scan the QR code.
   - **Pairing code (`phone`):** Enter your phone number in international format and type the pairing code displayed in Trioditis into WhatsApp on your phone.

## Unsupported & known limits

- **Explicit "load older" backfill (`backfill` command):** Refused with `unsupported` for WhatsApp. `mautrix-whatsapp` treats an empty range response as end-of-history and prunes cached history rows, including newer unimported ones. History arrives automatically through `bridgev2`'s own link-time sync instead.
- **Edited media captions:** Editing a media caption cannot look up the previous media metadata (`Bot.GetEvent` is stubbed because the bridge host keeps no plaintext content), so caption edits may drop attachment metadata fields.
- **Best-effort `notAfter` send deadline:** Checked before handoff (11-minute margin) and when reading media (2-minute margin). Past handoff, `whatsmeow`'s per-login `messageSendLock` does not honor context deadlines and waits indefinitely for an ack after a reconnect, which can delay queued sends past `notAfter`. Late sends are always reported truthfully (`sent` or `unknown`), never falsely marked `expired`.
- **Transport-level frame retry inside `whatsmeow`:** If a connection drops before WhatsApp acknowledges a frame, `whatsmeow` may retransmit the same frame (same message ID, deduplicated by WhatsApp) after reconnecting. Any connector error after handoff is therefore reported as `unknown` and never retried by Trioditis.
- **Unsupported event types:** Polls, call notices, and multi-attachment single messages (max one attachment per send) are currently dropped or unsupported.
- **Avatars older than 10 minutes:** Media uploads live in memory for 10 minutes; a new device joining later sees no avatar until the chat/contact avatar updates (`avatarUnchanged: true`).

## What's stored in plaintext

Beyond `bridgev2`'s shared tables (`portal`, `ghost`, `user_login`):

- **`whatsapp_history_sync_message`:** Raw history-sync protobuf batches until imported and deleted by the connector.
- **`whatsmeow_event_buffer`:** Decrypted incoming protobufs held briefly between decryption and handler completion (necessary because Signal/WhatsApp messages can only be decrypted once). Cleared immediately on success; leftover rows from crashes or DB errors are swept at startup and hourly once older than 14 days (`internal/wabuffer`).
- **`whatsmeow` device & contacts tables:** Session keys, push names, and phone numbers.

All of these require running Trioditis on an **encrypted disk** (see [Encryption at rest](/self-hosting/backup-and-keys/#encryption-at-rest)).

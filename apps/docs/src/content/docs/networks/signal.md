---
title: Signal
description: Implementation status, libsignal build details, no-retry patch, login flow, known limits, and plaintext notes for Signal.
---

Signal runs through a patched copy of `go.mau.fi/mautrix-signal` (`v0.2611.0`) linked via cgo against Signal's official Rust **`libsignal` (`v0.106.1`)** library, acting as a linked secondary device alongside your phone.

| Property           | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| **Network ID**     | `signal`                                                                            |
| **Maturity**       | **Experimental** _(v1 target: Stable)_                                              |
| **Terms risk**     | No (uses Signal's official linked-device protocol)                                  |
| **Operator setup** | None (Docker installer compiles `libsignal` automatically when `signal` is enabled) |
| **New chats from** | Contacts, phone numbers, or Signal usernames                                        |

## Implementation status

- **Implemented:** Linked-device QR flow (auto-refreshing every 45s up to 20 times), link-time history transfer (`backup5`), DMs and groups, replies, edits, reactions, deletions, read receipts, typing indicators, media, no-retry send patch (`third_party/mautrix-signal.patch`) verified by automated mock-Signal tests (`signalsend_libsignal_test.go`), log redaction filter (`signallog.go`), and 35-day `signalmeow_event_buffer` sweep (`internal/signalsweep`).
- **Remaining before Stable:** Live end-to-end verification and a week on the canary ledger with a real Signal account, plus `arm64` Docker build verification (x86_64 Rust build verified).

## How to connect

1. Open **Settings → Accounts → Signal → Link a device**.
2. On your phone, open Signal → **Settings → Linked devices → Link new device** and scan the QR code.
3. Choose **Transfer message history** if you want recent chats imported (the bridge waits up to an hour for the encrypted transfer, then imports 100 messages per batch with a 5-second delay between batches).
4. The bridge appears as **Trioditis** under Linked devices. Logging out in Trioditis unlinks the device and wipes its `signalmeow_*` database rows.

## Building with Signal (developers)

Self-hosted Docker installs build `libsignal` automatically (`--build-arg WITH_SIGNAL=1`) whenever `signal` is included in `--networks` (first build adds several minutes and a few GiB of RAM).

For local `pnpm dev --network signal`, provide `libsignal_ffi.a` (`v0.106.1`) in `.data/libsignal/` or `LIBSIGNAL_FFI_DIR`—either exported via Docker:

```sh
docker build -f deploy/docker/bridge-host.Dockerfile --target libsignal-export -o .data/libsignal .
```

or built locally with Rust `1.98.1` (`cargo build -p libsignal-ffi --release --locked`).

## Why Trioditis patches `mautrix-signal`

Upstream `mautrix-signal` automatically resends messages on dropped WebSockets and `500`/`503` responses, which can deliver duplicates. Trioditis pins a minimal, CI-verified patch (`apps/bridge-host/third_party/mautrix-signal.patch`) so any ambiguous send or 60-second unanswered send returns `unknown` instead of silently retrying, and caches messages for Signal decryption-error retries **only** for recipients Signal confirmed accepting. An edit or a deletion that reaches only some of a group's members is reported as uncertain too (`sendChange`), so the app doesn't show an edit as saved, or drop its copy of a message, that some members still see as it was.

## Unsupported & known limits

- **Outgoing voice notes & GIF stickers:** Require `ffmpeg` (not bundled in the bridge-host image), so outgoing voice notes are currently refused. Incoming AAC voice notes work as-is.
- **No subsequent history backfill:** Signal servers don't store history; only what your phone transfers during linking is imported.
- **Signal protocol limits:** No threads, no edits or delete-for-everyone after 24 hours, no poll closing, and Signal automatically unlinks devices offline for 30+ days.
- **Note to Self avatar:** Blank (upstream points to an external `mxc://` URI unreachable without a homeserver).
- **Phone stays primary:** Your phone must remain registered on Signal.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables (`portal`, `ghost`, `user_login`):

- **`signalmeow_event_buffer`:** Decrypted incoming protobufs held until handled; swept at startup and hourly once older than 35 days (`internal/signalsweep`).
- **`signalmeow_backup_*`:** History-transfer messages, chats, and recipients; messages/chats delete as each chat finishes importing, and recipients delete once no archived chats remain.
- **`signalmeow_recipients` & `signalmeow_device`:** Contact names, phone numbers, profile keys, and linked-device cryptographic state (deleted on logout).
- **Log filtering:** `signallog.go` strips sensitive fields (`backup_info`, `contact`, and trace payload fields) from every JSON log line before output.

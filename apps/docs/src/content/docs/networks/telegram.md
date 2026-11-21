---
title: Telegram
description: Implementation status, operator API credentials, login flows, known limits, and plaintext notes for Telegram.
---

Telegram runs through `go.mau.fi/mautrix-telegram`'s Go rewrite (`v0.2611.0`, MTProto via `gotd`), bridging private chats, groups, supergroups, channels, and forum topics as a Telegram Desktop-style session.

| Property           | Value                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Network ID**     | `telegram`                                                                                              |
| **Maturity**       | **Beta**                                                                                                |
| **Terms risk**     | No (official Telegram client API using your own API ID)                                                 |
| **Operator setup** | **Required:** `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org) |
| **New chats from** | Existing contacts                                                                                       |

## Implementation status

- **Implemented:** QR code login (auto-refreshing ~30s, with 2FA cloud password support) and phone-number login, private chats/groups/supergroups/channels/topics, replies, edits, reactions, media, memory-backed conversion temp dir (`TMPDIR=/dev/shm`), and automatic 5-minute `telegram_file` cache pruning so repeated media doesn't reference expired bridge uploads.
- **Remaining:** Live end-to-end verification with real operator Telegram API credentials.

## Operator setup (required)

Telegram requires each server operator to supply their own API ID and hash (one pair serves all members on the server):

1. Sign in at [my.telegram.org](https://my.telegram.org) → **API development tools** and create an application (Platform: **Desktop**).
2. Pass the credentials to the installer (saved in `deploy/.env` for future runs):

```sh
deploy/install/install.sh --telegram-api-id <api_id> --telegram-api-hash <api_hash>
```

Without these credentials, default installs skip Telegram; explicitly specifying `--networks telegram` without them stops the installer. For local dev (`pnpm dev --network telegram`), export `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in your shell.

## How to connect

Open **Settings → Accounts → Telegram** and choose either:

- **Scan a QR code (`qr`):** On your phone, open Telegram → **Settings → Devices → Link Desktop Device** and scan the QR code (enter your 2FA cloud password if enabled).
- **Phone number (`phone`):** Enter your international phone number (`+1...`), then the login code Telegram sends and your 2FA password if set. _(Telegram may require QR login if your account hasn't configured a login email.)_

The session appears as **Trioditis** in Telegram's **Devices** list.

## Unsupported & known limits

- **Secret chats & calls:** Not bridged by the connector; they stay on your phone.
- **Animated `.tgs` stickers & non-standard sticker sends:** `.tgs` Lottie stickers arrive as `application/x-tgsticker` files because `lottieconverter` and `ffmpeg` are not bundled in the bridge-host image. Static and WebM video stickers work as-is.
- **Bot & manual flows:** Intentionally omitted from the client UI.
- **Initial chat sync:** Creates the 15 most recently active chats on login; older chats appear as new messages arrive. Saved Messages has no avatar.
- **One login per Telegram account per server:** Connecting the same Telegram account twice on one server replaces the earlier login.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** MTProto auth key (full session credential), data center, and phone number (cleared on logout).
- **`telegram_phone_number` & `telegram_username`:** Seen phone numbers and public `@usernames` mapped to Telegram IDs (shared across logins, not cleared on logout).
- **`message.metadata.content_hash`:** Unsalted SHA-256 of message text/HTML, link preview URL, and media ID used to suppress no-op edits when link previews load (also logged in base64 on sends). Not currently bounded.
- **`telegram_file`:** Pruned on startup and every minute past 5 minutes.

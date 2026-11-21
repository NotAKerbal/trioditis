---
title: Google Voice
description: Implementation status, cookie sign-in, unsigned-send caveats, known limits, and plaintext notes for Google Voice.
---

Google Voice bridges SMS and MMS texts on a Google Voice number via `voice.google.com`'s web API (`go.mau.fi/mautrix-gvoice` `v0.2611.0`). No phone needs to stay online.

| Property           | Value                                                            |
| ------------------ | ---------------------------------------------------------------- |
| **Network ID**     | `gvoice`                                                         |
| **Maturity**       | **Experimental**                                                 |
| **Terms risk**     | **Yes** (unofficial web API client using Google session cookies) |
| **Operator setup** | None                                                             |
| **New chats from** | Not supported yet                                                |

## Implementation status

- **Implemented:** Google cookie sign-in (via sign-in browser or manual cookie paste), 20-thread initial sync, single-send HTTP transport wrapper (`gvoiceSendOnce` converts network errors, 5xx, and redirects on sends into uncertain `408` timeouts so messages never double-send), SMS/MMS text and pictures, read markers, and backward backfill.
- **Remaining:** Live account verification and evaluation of Google's unsigned-send rate limits.

## How to connect

Ensure your Google account already has an active Google Voice number at `voice.google.com`.

1. Open **Settings → Accounts → Google Voice → Sign in with Google** and accept the terms warning.
2. Sign in via the **sign-in browser** (or pick **Paste cookies instead** if Google blocks automated sign-in—copy `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, and optional `OSID`, `__Secure-1PSIDTS`, `COMPASS` from a private browser window at `https://voice.google.com`, then close without signing out).

## Unsupported & known limits

- **Unsigned sends (no Electron helper):** `voice.google.com` normally computes an obfuscated browser signature ("botguard") per send. Because the bridge-host container does not bundle Electron/Xvfb, sends go out unsigned (`"!"`). Receiving is unaffected, but Google may rate-limit or reject unsigned sends (`electron status: unavailable` in bridge logs).
- **Text and pictures only:** No reactions, replies, edits, or typing indicators (Google Voice doesn't have them). Calls and voicemails are **not** bridged.
- **Size & group limits:** Connector advertises 160 characters per text, pictures up to 2 MiB (PNG/JPEG/GIF/BMP/TIFF), and group texts up to 7 other participants.
- **Account risk:** Driving `voice.google.com` unofficially can cause rate limits, flags, or locks on your Google Voice number or Google account. Use only for ordinary personal texting.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata.cookies`:** Full Google account session cookies (not scoped solely to Google Voice). Revoke by logging out in Trioditis and signing out of the session under Google Account → Security → Your devices.
- **`portal.metadata` & `ghost.metadata`:** Participant phone numbers. No message bodies are stored by the connector.

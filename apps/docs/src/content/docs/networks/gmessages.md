---
title: Google Messages
description: Implementation status, Google account pairing, known limits, and plaintext notes for Google Messages (SMS/MMS/RCS).
---

Google Messages bridges SMS, MMS, and RCS through the Google Messages app on an Android phone using Google's "Messages for web" pairing protocol (`go.mau.fi/mautrix-gmessages` `v0.2611.0`).

| Property           | Value                                              |
| ------------------ | -------------------------------------------------- |
| **Network ID**     | `gmessages`                                        |
| **Maturity**       | **Beta** _(v1 target: Stable)_                     |
| **Terms risk**     | No (uses official Messages for web device pairing) |
| **Operator setup** | None                                               |
| **New chats from** | Existing contacts or phone numbers                 |

## Implementation status

- **Implemented:** Google cookie login flow (via sign-in browser or manual cookie paste) + phone emoji verification, `aggressive_reconnect` (automatically reclaims session if Messages for web is opened elsewhere), single-send HTTP transport guard (`gmessagesSendOnce`, sends and deletions) + disabled upstream `FAILURE_2`/`FAILURE_3` auto-retries so ambiguous SMS/RCS sends always settle as `unknown`, 3-minute send timeout with 1-hour late-echo window, SMS/MMS/RCS messaging, RCS reactions/replies, media up to 100 MiB, and backward backfill.
- **Remaining before Stable:** Live end-to-end verification and a week on the canary ledger with a real Android phone.

## How to connect

Before starting, open **Google Messages** on your Android phone → profile picture → **Device pairing** and verify it is signed in to your Google account. Keep the phone online.

1. Open **Settings → Accounts → Google Messages → Sign in with Google**.
2. Sign in through the server's **sign-in browser** (or select **Paste cookies instead** if Google rejects automated sign-in with _"This browser or app may not be secure"_—copy `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `OSID`, and optional `__Secure-1PSIDTS` from a private browser window at `messages.google.com/web/config`, then close the window **without signing out**).
3. Tap the matching **emoji** on your phone when prompted. The device appears as **Trioditis** under Device pairing.

## Unsupported & known limits

- **Android phone must stay on and online:** The phone performs all SMS/MMS/RCS transmission; messages pause while the phone is offline and catch up when it reconnects. Turn off battery optimization for Google Messages if pairing drops.
- **Single active web session:** Opening `messages.google.com` in a browser steals the session temporarily until `aggressive_reconnect` takes it back; avoid using Messages for web concurrently.
- **QR pairing disabled:** Upstream disabled anonymous QR pairing because Google no longer supports it reliably; Google account login is the only flow.
- **Voice note formats:** No `ffmpeg` in the bridge-host image—outgoing voice notes must be MP4/AAC (Ogg voice notes are refused); incoming voice notes arrive in the phone's native format (AMR/MP4).
- **Edits & SMS replies:** Outbound edits are unsupported; SMS replies arrive as plain text (RCS supports native replies and reactions).
- **No push registration:** Uses long-polling against Google's relay.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** Full Google account session cookies (refreshed automatically), pairing keys, and SIM carrier/number. Because these represent a signed-in Google session, keep the server disk encrypted; revoke via logout + Device pairing or Google Account security settings.
- **`message.metadata`:** Unsalted `text_hash` (SHA-256 of subject/text for edit detection) and RCS group `status_text` (e.g., `"Read by Alice, Bob"`).
- **`gmessages_direct_conversation` & `ghost.metadata`:** Phone numbers and contact IDs.

---
title: GroupMe
description: Implementation status, login flows, 30-minute plaintext sweep, known limits, and plaintext notes for GroupMe.
---

GroupMe bridges groups and DMs through the open-source `bridgev2` GroupMe connector (`GMConnector`), communicating over GroupMe's Bayeux/Faye WebSocket push service (`push.groupme.com`) plus 5-minute periodic resyncs.

| Property           | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| **Network ID**     | `groupme`                                                                         |
| **Maturity**       | **Experimental**                                                                  |
| **Terms risk**     | No (GroupMe publishes a developer API for personal access tokens; see note below) |
| **Operator setup** | None                                                                              |
| **New chats from** | Not supported in UI yet                                                           |

## Implementation status

- **Implemented:** `access-token` and `password` (with SMS 2FA) login flows, compile-time interface checks against `mautrix v0.33.0`, groups and DMs, replies, native emoji reactions, 15-minute edit window, deletes, typing, read receipts, images/GIFs/videos/locations/group files, initial & backward backfill, and a background sweep (`internal/networks/groupme.go`) that deletes `native_content` plaintext from `message.metadata` every 5 minutes once messages are 30 minutes old.
- **Remaining:** Live end-to-end verification with a real GroupMe account (and PostgreSQL verification of the `native_content` sweep, tested on SQLite so far).

## How to connect

Open **Settings → Accounts → GroupMe** and choose either:

- **Access token (`access-token`, recommended):** Sign in at [dev.groupme.com](https://dev.groupme.com/) and click **Access Token** (or copy `access_token` from Local Storage at `https://web.groupme.com/`). Works for Google/Microsoft/Apple SSO accounts too.
- **Email or phone and password (`password`):** Enter your email or international phone number and GroupMe password (plus SMS 2FA code if enabled). _(Note: uses GroupMe's Android app login flow; prefer `access-token` if you want to stick to official developer tokens.)_

Logging out deletes the token from Trioditis's database but does not revoke it at GroupMe (GroupMe access tokens do not expire automatically).

## Unsupported & known limits

- **Open polls:** Dropped by the bridge host today; poll reminders and results still arrive as text, and creating/voting in polls isn't supported.
- **Editing media captions:** Fails because the bridge host keeps no plaintext event store (`Bot.GetEvent`). Text-only edits work within GroupMe's 15-minute window.
- **Formatting & DM files:** Rich formatting flattens to plain text (max 1,000 chars). Generic file uploads work in groups (up to 50 MB) but are disallowed in DMs by GroupMe; images/video max 25 MiB.
- **Reactions & typing quirks:** GroupMe reliably pushes reaction updates only on your own messages (others sync on reconnect/refresh). Typing indicators from Trioditis may fade after 5 seconds.
- **Second-precision backfill boundary:** Messages sharing the exact same second at a backfill page boundary may be missed.
- **Media validation:** Upstream connector notes media validation is still incomplete.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`message.metadata.native_content` (bounded to ~35 min):** Temporarily stores message text and attachment metadata so edits within GroupMe's 15-minute edit window can preserve attachments. Trioditis's background sweep strips `native_content` at startup and every 5 minutes once messages are older than 30 minutes.
- **`user_login.metadata`:** GroupMe access token, user ID, and active poll IDs/voter IDs (no poll text).

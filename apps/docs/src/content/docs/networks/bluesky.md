---
title: Bluesky
description: Implementation status, app-password login, known limits, and plaintext notes for Bluesky direct messages.
---

Bluesky bridges `chat.bsky` direct messages through `go.mau.fi/mautrix-bluesky` (`v0.2510.0`, `BlueskyConnector`), authenticating with an official Bluesky **app password**.

| Property           | Value                                      |
| ------------------ | ------------------------------------------ |
| **Network ID**     | `bluesky`                                  |
| **Maturity**       | **Experimental**                           |
| **Terms risk**     | No (uses Bluesky's official app passwords) |
| **Operator setup** | None                                       |
| **New chats from** | Not supported yet                          |

## Implementation status

- **Implemented:** App-password login with normalized server/handle inputs (`https://`, trailing `/`, and leading `@` stripped automatically; defaults to `bsky.social`), single-send HTTP transport wrapper (`TestBlueskySendsAreNotRetried` & `TestBlueskySendsAreNotRedirected` keep retries for reads only and mark ambiguous sends `unknown`), text DMs, read receipts, initial recent sync, and 5-second message polling.
- **Remaining:** Live end-to-end verification with a real Bluesky account.

## How to connect

1. In Bluesky, open **Settings → Privacy and security → App passwords → Add app password**.
2. Name it (e.g., `Trioditis`) and **check "Allow access to your direct messages"**—without that permission, sign-in succeeds but every chat request fails.
3. Open **Settings → Accounts → Bluesky → App password** in Trioditis and enter:
   - **Server:** `bsky.social` (or your custom PDS hostname)
   - **Username or email:** your handle (e.g., `you.bsky.social`) or account email
   - **Password:** the generated app password (`xxxx-xxxx-xxxx-xxxx`)

Revoking the app password in Bluesky immediately ends the bridge session. _(Avoid using your main account password—especially with email 2FA, which the connector cannot prompt for.)_

## Unsupported & known limits

The upstream Bluesky connector is minimal:

- **Text only, both ways:** Outbound media sends are refused (`unsupported`). Incoming embeds (shared posts, images) arrive as their accompanying text only (which may be empty).
- **No reactions, edits, replies, or deletions:** Not bridged in either direction (Bluesky has no edits; reactions and deletions are ignored). Outbound read receipts are sent.
- **No backward history backfill:** Only the newest messages of the 20 most recent conversations sync on connect; older history cannot be fetched.
- **5-second polling:** New messages arrive via polling every 5 seconds rather than push.
- **Refresh expiry:** If the bridge host is offline past the JWT refresh token lifetime (or the app password is revoked), reconnect with a fresh login.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata` & `remote_profile`:** Access/refresh JWTs, handle, DID, PDS host, account email, and chat log cursor (cleared on logout).
- **No message bodies stored by the connector.**

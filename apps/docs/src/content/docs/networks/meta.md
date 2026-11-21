---
title: Messenger
description: Implementation status, cookie login, optional proxy config, known limits, and plaintext notes for Facebook Messenger.
---

Facebook Messenger bridges one-to-one and group chats—both standard and end-to-end encrypted (via `whatsmeow`)—using `go.mau.fi/mautrix-meta` (`v0.2611.0`, `MetaConnector`).

| Property           | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Network ID**     | `meta`                                                                               |
| **Maturity**       | **Beta**                                                                             |
| **Terms risk**     | **Yes** (Meta forbids unofficial clients; accounts may be checkpointed or suspended) |
| **Operator setup** | Optional `META_PROXY` for datacenter IPs                                             |
| **New chats from** | Existing contacts                                                                    |

## Implementation status

- **Implemented:** `facebook.com` and `messenger.com` cookie flows (via sign-in browser or manual cookie paste), unencrypted and E2EE live chats, replies, edits, reactions, media, full unencrypted conversation backfill, 14-day `whatsmeow_event_buffer` sweep, and strict `GlobalLogger` filtering (`globallog.go`) that strips raw Meta protocol payloads from decoder warnings.
- **Remaining:** Live end-to-end account verification.

## How to connect

1. Open **Settings → Accounts → Messenger**, choose **Sign in on facebook.com** (`facebook`) or **Sign in on messenger.com** (`messenger`), and accept the terms warning.
2. Sign in inside the **sign-in browser** and complete any 2FA or security prompt. Once Facebook/Messenger loads, the bridge collects `xs`, `c_user`, and `datr` automatically.
3. **Manual fallback:** Choose **Paste cookies instead**, sign in inside a private browser window, copy `xs` (leave `%3A` encoded), `c_user`, and `datr` from DevTools Cookies, and close the window **without logging out**.

Logging out in Trioditis drops local cookies and the E2EE device, but does **not** revoke the session at Meta—end it under Facebook **Settings → Security and login → Where you're logged in**.

## Operator settings (optional)

Meta frequently challenges datacenter IP addresses. If your server runs on a VPS rather than a home connection, add a residential proxy URL (`http://`, `https://`, or `socks5://`) to `deploy/.env` and restart `bridge-meta`:

```sh
META_PROXY=socks5://user:pass@proxy.example:1080
```

The sign-in browser's egress proxy automatically routes Messenger sign-in traffic through `META_PROXY` as well so sign-in and bridging share the same IP.

## Unsupported & known limits

- **Encrypted chat history (`e2ee_backfill`):** Disabled in code because it requires an optional Messenger PIN field not yet modeled in the login stepper. Encrypted chats bridge all new messages from login onward; unencrypted chats backfill full history.
- **Username/password flows (`messenger-lite`):** Omitted because they frequently trigger CAPTCHAs or multi-choice prompts the generic stepper cannot render.
- **Polls & calls:** Polls and call notices are not rendered in the app yet (note: `mautrix-meta` still writes incoming poll metadata to `message.metadata`).
- **Caption edits on old media:** Media edit cache lasts 20 minutes in memory; editing a caption older than 20 minutes (or after restart) drops the attachment reference and bridges as text.
- **Unencrypted send retries:** `mautrix-meta` retries unencrypted sends up to 5 times internally using the same offline threading ID; if the final attempt is ambiguous, Trioditis marks the send `unknown` and never retries further.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`whatsmeow_event_buffer`:** Decrypted incoming E2EE Messenger messages held briefly until handled; swept at startup and hourly past 14 days.
- **`user_login.metadata` & `whatsmeow_*`:** Session cookies (`xs`, `c_user`, `datr`), push keys, and E2EE device keys (deleted on logout).
- **`message.metadata`:** Incoming poll questions/options/votes (unbounded until chat deletion).
- **Log filtering:** `GlobalLogger` drops raw protocol fields from `messagix/lightspeed` decoder warnings and never logs below `warn`.

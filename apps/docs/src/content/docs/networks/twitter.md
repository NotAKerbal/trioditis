---
title: X
description: Implementation status, cookie + X Chat PIN login, known limits, and plaintext notes for X (Twitter) direct messages.
---

X bridges both legacy direct messages and end-to-end encrypted **X Chat** conversations through `go.mau.fi/mautrix-twitter` (`v0.2609.0`, `TwitterConnector`).

| Property           | Value                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Network ID**     | `twitter`                                                                                                   |
| **Maturity**       | **Experimental**                                                                                            |
| **Terms risk**     | **Yes** (X forbids unofficial/automated session access; accounts may face verification locks or suspension) |
| **Operator setup** | None                                                                                                        |
| **New chats from** | X username                                                                                                  |

## Implementation status

- **Implemented:** `x.com` cookie login + 4-digit X Chat PIN recovery (via sign-in browser or manual cookie paste), Chrome-impersonating HTTP/2 transport verified against `x.com` (`TestTwitterTransportReachesX`), `mautrix v0.33.0` interface compatibility verified, X Chat & legacy DMs, groups, message requests, replies, edits, reactions, deletions, media, and ambiguous-send `unknown` handling.
- **Remaining:** Live account end-to-end verification, and testing the hidden-browser `password` ("Castle token") flow with `login-browser`.

## How to connect

1. Open **Settings → Accounts → X → Sign in on x.com** and accept the terms warning.
2. Sign in inside the **sign-in browser** (or select **Paste cookies instead**, sign in inside a private window at `https://x.com/i/flow/login`, copy `ct0` and `auth_token` from DevTools Cookies, and close without signing out).
3. Enter your **4-digit X Chat passcode (PIN)** to recover your encrypted X Chat keys from X's Juicebox backup.

:::caution[Watch your X Chat PIN carefully]

- X permits only a few wrong PIN attempts before locking X Chat for your account (the step displays remaining attempts).
- If your account has **never** set up X Chat, whatever 4-digit PIN you enter registers **new** X Chat keys on your account—remember it, as X's own apps will ask for it.
- Note that the PIN field is currently rendered as a visible 2FA-code input rather than masked.
  :::

## Unsupported & known limits

- **Password flow (`password`):** Not offered yet (requires executing X's hidden "Castle token" script; `login-browser` supports hidden steps, but this flow hasn't been live-tested).
- **Quoted reply previews:** Outbound replies reference target message IDs without X's quoted text snippet (the bridge host retains no plaintext message bodies to quote).
- **Edits & delete-for-everyone:** Limited to X Chat conversations (edits within 15 minutes, max 10 edits). Legacy DMs only support delete-for-me.
- **Media caps & voice notes:** Outbound images/GIFs max 5 MiB, videos max 15 MiB. Outbound voice messages are not converted to Opus (no `ffmpeg` in container).
- **Initial sync:** Syncs the 20 most recent conversations at connect (`conversation_sync_limit`); large X Chat inboxes continue syncing in the background.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** Session cookies (`auth_token`, `ct0`), recovered **X Chat private keys** (`secret_key`, `signing_key`), Web Push keys, and inbox cursors (cleared on logout).
- **`portal.metadata`:** Per-conversation X Chat keys and tokens.
- **No message content stored.** Never run with `--verbose` in production—debug level logs unencrypted request payloads.

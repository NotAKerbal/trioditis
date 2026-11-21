---
title: LinkedIn
description: Implementation status, cookie login, single-send transport guard, known limits, and plaintext notes for LinkedIn messaging.
---

LinkedIn bridges one-to-one and group conversations through `go.mau.fi/mautrix-linkedin` (`v0.2611.0`, `LinkedInConnector`).

| Property           | Value                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Network ID**     | `linkedin`                                                                                                                         |
| **Maturity**       | **Experimental**                                                                                                                   |
| **Terms risk**     | **Yes** (LinkedIn's User Agreement forbids automated/third-party access; sessions may trigger verification or account restriction) |
| **Operator setup** | None                                                                                                                               |
| **New chats from** | Existing contacts                                                                                                                  |

## Implementation status

- **Implemented:** `linkedin.com` cookie login (via sign-in browser or manual header paste), clean contact names without `" (LinkedIn)"` suffix, single-send HTTP transport guard (`linkedinSendOnce` prevents `linkedingo` from retrying message sends or reaction toggles on connection errors, 5xx, or redirects—verified by `TestLinkedInSendIsNotRepeated` and `TestLinkedInReactionIsNotRepeated`), DMs and groups, replies, edits, reactions, deletions, and media up to 20 MiB.
- **Remaining:** Live end-to-end verification with a real LinkedIn account.

## How to connect

1. Open **Settings → Accounts → LinkedIn → Sign in on linkedin.com** and accept the terms warning.
2. Sign in inside the **sign-in browser** and complete any verification until your feed loads; the bridge captures the required Voyager request headers automatically.
3. **Manual fallback:** Choose **Paste cookies instead**, sign in inside a private browser window at `https://www.linkedin.com/login`, open DevTools → **Network** → filter `voyager`, select a `/voyager/api/...` request, copy `cookie` (containing `JSESSIONID` and `li_at`), `x-li-track`, `x-li-page-instance` (plus recommended `user-agent` and optional `sec-ch-*` headers), and close the window **without signing out**.

Logging out in Trioditis signs that specific session out of LinkedIn without affecting your other devices.

## Unsupported & known limits

- **Email/password flow (`password`):** Not offered because LinkedIn verification steps ask users to pick from a list of options (`select` options aren't carried by the login protocol yet).
- **Outgoing voice messages:** Require `ffmpeg` (not bundled in the bridge-host image), so outbound voice notes are refused. Other media works up to 20 MiB.
- **Formatting & text cap:** Rich formatting is stripped except mentions; max 8,000 characters per message.
- **Initial conversation sync:** Syncs the 10 most recently active conversations at connect; older threads appear when they receive new activity.
- **Session expiry:** Sessions typically last months; when LinkedIn expires or challenges a session, reconnect with fresh cookies.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** Full LinkedIn session cookies (`li_at`, `JSESSIONID`), `X-LI-Track`, page instance, browser headers, and sync cursor (cleared on logout).
- **`message.metadata.edit_hash`:** Unsalted SHA-256 of edited message body JSON (retained for the message's lifetime to deduplicate edits).
- **Debug logging warning:** At `--verbose`, empty search results log raw LinkedIn responses; never enable `--verbose` in production.

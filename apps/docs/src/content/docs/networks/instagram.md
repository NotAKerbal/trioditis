---
title: Instagram
description: Implementation status, cookie login, optional proxy config, known limits, and plaintext notes for Instagram direct messages.
---

Instagram bridges one-to-one and group direct messages through `go.mau.fi/mautrix-meta` (`v0.2611.0`, `pkg/igconnector`, `IGConnector`), running in its own dedicated `bridge-instagram` process separate from Messenger.

| Property           | Value                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| **Network ID**     | `instagram`                                                                        |
| **Maturity**       | **Beta**                                                                           |
| **Terms risk**     | **Yes** (Meta forbids unofficial clients; accounts may be challenged or suspended) |
| **Operator setup** | Optional `INSTAGRAM_PROXY` for datacenter IPs                                      |
| **New chats from** | Existing contacts                                                                  |

## Implementation status

- **Implemented:** `instagram.com` cookie login (via sign-in browser or manual cookie paste), DMs and groups, replies, edits, deletions, reactions, media and shared posts/reels, sends, edits, deletions and reactions posted once (`instagramWritesOnce` turns off messagix's retries for those GraphQL mutations, so an ambiguous outcome settles as `unknown`—verified by `TestInstagramWritesGoOnce` and `TestInstagramEditAndUnsendAreNotRepeated`), recent history on first inbox page, and shared `GlobalLogger` filtering stripping raw decoder payloads.
- **Remaining:** Live end-to-end account verification.

## How to connect

1. Open **Settings → Accounts → Instagram → Sign in on instagram.com** and accept the terms warning.
2. Sign in inside the **sign-in browser** and pass any security check. Once the inbox loads, the bridge collects the required session cookies automatically.
3. **Manual fallback:** Choose **Paste cookies instead**, sign in inside a private window at `https://www.instagram.com/accounts/login/`, open your inbox once, copy `sessionid`, `csrftoken`, and `ds_user_id` (plus optional `rur`, `shbid`, `shbts`, `mid`, `ig_did` if present), and close the window **without logging out**.

Logging out in Trioditis drops local cookies without revoking Instagram's session—end it under Instagram **Settings → Accounts Center → Password and security → Where you're logged in**.

## Operator settings (optional)

For servers hosted on datacenter IPs that Instagram challenges, add a residential proxy URL (`http://`, `https://`, or `socks5://`) to `deploy/.env` and restart `bridge-instagram`:

```sh
INSTAGRAM_PROXY=socks5://user:pass@proxy.example:1080
```

The sign-in browser's egress proxy automatically routes Instagram logins through `INSTAGRAM_PROXY` too.

## Unsupported & known limits

- **End-to-end encrypted Instagram DMs:** Not bridged (Instagram connector does not use `whatsmeow`).
- **Older conversation pagination (`thread_backfill.batch_count: 0`):** Only chats on the first inbox page at login (plus chats with new activity) appear automatically; older conversations aren't paged through.
- **Shared posts/reels in history (`disable_xma_backfill: true`):** Backfilled posts/reels appear as links rather than downloaded media; live ones download normally.
- **Password flows (`android`, `instagram-password`):** Omitted from the UI because verification/CAPTCHA prompts aren't supported in the generic stepper.
- **Polls & calls:** Not rendered in the app yet.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **`user_login.metadata`:** Session cookies (deleted on logout).
- **`meta_reconnection_state`:** Cached page state (session tokens and your own profile name/username; no messages or other people's names; expires after 24 hours).
- **`message.metadata`:** Unfetched shared-post URLs (`xma_fetch_meta`) from backfilled history (retained until chat deletion).
- **No decrypted-event buffer:** Unlike Messenger, Instagram has no `whatsmeow_event_buffer`.

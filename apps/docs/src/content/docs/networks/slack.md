---
title: Slack
description: Implementation status, workspace mapping, login flows, known limits, and plaintext notes for Slack.
---

Slack connects one workspace per login through `go.mau.fi/mautrix-slack` (`v0.2611.0`, `SlackConnector`). Connect multiple workspaces as separate Slack accounts.

| Property           | Value                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network ID**     | `slack`                                                                                                                                             |
| **Maturity**       | **Experimental**                                                                                                                                    |
| **Terms risk**     | **Yes** (browser token/email flows act as an unofficial client; workspace admins can see active sessions; Slack app bot flow uses the official API) |
| **Operator setup** | None                                                                                                                                                |
| **New chats from** | Existing contacts                                                                                                                                   |

## Implementation status

- **Implemented:** Browser sign-in (`token`), email code (`email`), and Slack app bot (`app`) flows, workspaces as `space` parents with channels/group DMs/DMs underneath, threads (`threadRoot` + turning Trioditis replies into Slack thread replies), edits, deletions, Unicode & shortcode reactions (`custom_emoji_reactions: false` to avoid dead `mxc://` links), media up to 50 MiB, PostgreSQL array wrapper fix (`slackdb.PostgresArrayWrapper = pq.Array`), and backfill.
- **Remaining:** Live end-to-end verification across workspaces, distinguishing `channel` vs. `group` chat kinds, and `select` field options for multi-workspace email sign-in.

## How to connect

1. **Sign in on slack.com (`token`, recommended):** Sign in via the **sign-in browser**—Trioditis automatically selects "use Slack in your browser", collects your `xoxc-` token and `d` (`xoxd-`) cookie, and completes sign-in.
   - **Manual fallback:** Open `https://app.slack.com/client` in a private browser window, extract your `xoxc-` token from `localStorage.localConfig_v2` in DevTools Console, copy the `d` cookie from Application/Storage → Cookies, paste both into **Paste cookies instead**, and close the window **without signing out**.
2. **Email code (`email`):** Enter your email and the 6-character code Slack sends (plus 2FA if required).
3. **Slack app (`app`):** For workspaces you administer, create a Socket Mode app from `mautrix-slack`'s manifest and provide the `xoxb-` bot token and `xapp-` app-level token. _(Bridges only what the bot can access and sends as the bot—not your personal DMs.)_

Logging out in Trioditis actively signs out the Slack session (`auth.signout`).

## Unsupported & known limits

- **Channels map as `group`:** The bridge host currently maps both Slack channels and group DMs to `ChatKind: 'group'` (with the workspace `space` as `parentPortalId`) rather than `'channel'`.
- **Multi-workspace email sign-in & CAPTCHAs:** The login protocol does not yet pass `select` field options for picking among multiple workspaces during the `email` flow (use `token` instead). Email-flow CAPTCHAs only work when `login-browser` is running and remain untested live.
- **Custom emoji images:** Custom emoji reactions arrive as `:shortcode:` text. Inline custom emoji in message HTML reference expired `mxc://` URIs with the shortcode as `alt` text.
- **Voice clip conversion:** Without `ffmpeg` in the container, Slack voice clips arrive in Slack's native format rather than Ogg/Opus.
- **Workspace edit/delete policies & Enterprise Grid:** Edits/deletes respect workspace restrictions; Enterprise Grid is untested.

## What's stored in plaintext

Beyond `bridgev2`'s shared tables:

- **No message bodies stored by the connector.**
- **`user_login`:** Workspace name, email, and live session tokens (`xoxc-`/`d` cookie or bot tokens; cleared on logout).
- **`emoji` table:** Workspace custom emoji shortcodes and Slack CDN URLs (pruned automatically as emoji are deleted).
- **Login step instructions:** On SSO/error responses during `email` flow, Slack's error text may include the workspace name.

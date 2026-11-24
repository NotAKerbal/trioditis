---
title: Networks Overview
description: Status, capabilities, sign-in methods, and operator controls for all 12 messaging networks in Trioditis.
---

Each messaging network runs as its own isolated Go `bridge-host` process implementing `mautrix` `bridgev2`'s `NetworkConnector`. By default, a self-hosted server builds and starts all 12 bridge hosts, and admins enable or disable networks for members inside **Admin settings → Networks** without restarting the server.

## Implementation status matrix

Every network carries a visible maturity label (`stable`, `beta`, or `experimental`) in the app and is tested against Trioditis's bridge host checks.

| Network                                 | ID          | Maturity         | Implementation status                                                                                             | Login flows                                 | ToS risk |
| --------------------------------------- | ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| [WhatsApp](/networks/whatsapp/)         | `whatsapp`  | **Stable**       | Primary network; full bridge + live pairing/messaging                                                             | QR code, phone pairing code                 | No       |
| [Signal](/networks/signal/)             | `signal`    | **Experimental** | Patched `mautrix-signal` + Rust `libsignal`; automated no-retry tests passing; awaiting live account soak         | Link a device (QR)                          | No       |
| [Google Messages](/networks/gmessages/) | `gmessages` | **Beta**         | Built with no-retry transport guard & aggressive reconnect; awaiting live Android phone verification              | Sign in with Google + phone emoji tap       | No       |
| [Google Voice](/networks/gvoice/)       | `gvoice`    | **Experimental** | Built with no-retry transport guard; unsigned sends (no Electron helper); awaiting live verification              | Sign in with Google                         | Yes      |
| [Telegram](/networks/telegram/)         | `telegram`  | **Beta**         | MTProto Go connector wired with file-cache sweep; requires operator API ID/hash; awaiting live verification       | QR code, phone number                       | No       |
| [Messenger](/networks/meta/)            | `meta`      | **Beta**         | Unencrypted + encrypted (whatsmeow) chats wired with global log filter & buffer sweep; awaiting live verification | Sign in on facebook.com / messenger.com     | Yes      |
| [Instagram](/networks/instagram/)       | `instagram` | **Beta**         | Direct messages wired with global log filter; E2EE chats unsupported; awaiting live verification                  | Sign in on instagram.com                    | Yes      |
| [Slack](/networks/slack/)               | `slack`     | **Experimental** | Workspaces, channels, DMs, threads wired; channels map as `group`; awaiting live verification                     | Sign in on slack.com, email code, Slack app | Yes      |
| [GroupMe](/networks/groupme/)           | `groupme`   | **Experimental** | Connector wired with 30-min `native_content` sweep; awaiting live verification                                    | Access token, email/phone & password        | No       |
| [LinkedIn](/networks/linkedin/)         | `linkedin`  | **Experimental** | Wired with single-send HTTP transport guard; awaiting live verification                                           | Sign in on linkedin.com                     | Yes      |
| [X](/networks/twitter/)                 | `twitter`   | **Experimental** | Legacy DMs + encrypted X Chat wired with HTTP/2 transport test; awaiting live verification                        | Sign in on x.com + X Chat PIN               | Yes      |
| [Bluesky](/networks/bluesky/)           | `bluesky`   | **Experimental** | Text-only DMs wired with no-retry transport guard; 5s polling; awaiting live verification                         | App password                                | No       |

### Editing and deleting your messages

What each connector allows for your own messages, and for how long after sending. The app offers Edit and Delete only within these limits.

| Network         | Edit       | Delete                            |
| --------------- | ---------- | --------------------------------- |
| WhatsApp        | 15 minutes | For everyone, 48 hours            |
| Signal          | 24 hours   | For everyone, 24 hours            |
| Google Messages | No         | Only from your phone, any time    |
| Google Voice    | No         | No                                |
| Telegram        | Any time   | For everyone, any time            |
| Messenger       | 15 minutes | For everyone, any time            |
| Instagram       | 15 minutes | For everyone, any time            |
| Slack           | Any time   | For everyone, any time            |
| GroupMe         | 15 minutes | For everyone, any time            |
| LinkedIn        | 60 minutes | For everyone, 60 minutes          |
| X               | 15 minutes | For everyone in X Chat; else, you |
| Bluesky         | No         | No                                |

Some networks also cap how many times a message can be edited (Signal 10, Messenger and Instagram 5, X 10); an edit past that is refused and the app says it wasn't saved.

### Not yet supported

- **Discord:** `mautrix-discord` still uses the legacy bridge framework rather than `bridgev2`. Discord will join once its `bridgev2` migration lands.
- **Future candidates:** iMessage (via an optional macOS companion).

## Limiting bridge hosts on smaller servers

Running all 12 bridge hosts uses extra memory, and Signal compiles `libsignal` from Rust source on the first build. Use `--networks` to restrict which bridge hosts run:

```sh
deploy/install/install.sh                              # All supported networks (default)
deploy/install/install.sh --networks whatsapp,signal   # Only WhatsApp and Signal
deploy/install/install.sh --networks all               # Re-enable every network
```

Your choice is saved in `deploy/.env` (`INSTALL_NETWORKS`). Dropping a network removes its container while keeping its volume and database intact.

## The sign-in browser (`login-browser`)

Seven networks authenticate through their own websites: **Google Messages, Google Voice, Messenger, Instagram, Slack, LinkedIn, and X**.

Trioditis runs an isolated **`login-browser`** container (Debian Chromium + launcher on an internal `signin` network with per-browser egress proxies) so members sign in interactively inside the app's login stepper—no copying cookies out of DevTools. Every login gets its own ephemeral Chromium process and never-reused UID (~0.5 GiB while open, 0 when idle; max `LOGIN_BROWSER_MAX=4`).

Manual **Paste cookies instead** always remains available as a fallback. See [Sign-in Browser Architecture](/architecture/signin-browser/) for full security details.

:::caution[Never run `--verbose` in production]
Several upstream connectors log phone numbers, contact names, or raw protocol payloads at debug level (`--verbose`). Keep bridge hosts at default log levels in production.
:::

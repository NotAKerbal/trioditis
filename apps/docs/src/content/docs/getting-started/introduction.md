---
title: Introduction
description: What Trioditis is, its core design principles, current development status, and supported networks.
---

_Trioditis_ ("of the three roads") is an open-source, self-hosted universal messaging hub: one fast, cohesive app for every messaging network you use, running on infrastructure you own.

Anyone can spin up a Trioditis server and invite family, friends, or teammates. Each member has their own account, connects their own messaging networks, and holds the keys to their own stored message history.

:::note[Development status]
Trioditis is in **active pre-release development** on `dev`. The core stack—Go bridge host with 12 network connectors, isolated Chromium sign-in browser, Node gateway, self-hosted Convex backend on PostgreSQL, sealed storage cryptography, desktop & web app, systemd auto-updater, encrypted backup & restore, and Docker Compose / Proxmox installer—is built and running. Expect rough edges while pre-release work continues toward v1.
:::

## Design principles

1. **Your server, your data.** Bridges and storage run on the operator's hardware. Nothing in the message path relies on a third-party hosted bridge cloud.
2. **Sealed by default.** Stored message content, media, chat names, and contact profiles are encrypted to each member's own keys before reaching the database. Operators can administer and back up the server without reading anyone's history.
3. **Reliability over features.** No silently lost messages, no hidden duplicates, and an honest `unknown` delivery state whenever a network outcome is ambiguous. Bridge health is always visible.
4. **Simple to operate.** One installer script sets up and upgrades the stack on any Linux box, VM, Proxmox VE host, or VPS across `x86_64` and `arm64`, with built-in automatic updates, encrypted backups, and one-command restore.
5. **Native-feeling everywhere.** Shared logic and crypto in one monorepo; platform-appropriate UI on desktop/web and mobile rather than lowest-common-denominator wrappers.
6. **Instant by default.** Clients are designed to open directly to your inbox from an encrypted local cache before the network responds.
7. **Built to expand.** Every messaging network plugs into the same `bridgev2` connector contract, advertises its capabilities, uses a single generic login stepper, and passes the same conformance suite.
8. **Agents are first-class, and on a leash.** External AI agents appear as conversations, authenticate via OAuth 2.1 over MCP, start with zero access, and act only within explicit per-chat grants and human approvals.

## Supported networks

Trioditis currently ships bridge hosts for **12 messaging networks**. Admins choose which ones to offer inside **Settings → Admin → Networks** without touching server config.

| Network             | ID          | Current maturity | Sign-in flow                                              | Platform ToS risk |
| ------------------- | ----------- | ---------------- | --------------------------------------------------------- | ----------------- |
| **WhatsApp**        | `whatsapp`  | Stable           | QR code or phone pairing code                             | No                |
| **Signal**          | `signal`    | Experimental     | Link a device (QR)                                        | No                |
| **Google Messages** | `gmessages` | Beta             | Sign in with Google + phone emoji tap                     | No                |
| **Google Voice**    | `gvoice`    | Experimental     | Sign in with Google                                       | Yes               |
| **Telegram**        | `telegram`  | Beta             | QR code or phone number _(requires Telegram API ID/hash)_ | No                |
| **Messenger**       | `meta`      | Beta             | Sign in on facebook.com / messenger.com                   | Yes               |
| **Instagram**       | `instagram` | Beta             | Sign in on instagram.com                                  | Yes               |
| **Slack**           | `slack`     | Experimental     | Sign in on slack.com, email code, or bot app              | Yes               |
| **GroupMe**         | `groupme`   | Experimental     | Access token or email/phone & password                    | No                |
| **LinkedIn**        | `linkedin`  | Experimental     | Sign in on linkedin.com                                   | Yes               |
| **X**               | `twitter`   | Experimental     | Sign in on x.com                                          | Yes               |
| **Bluesky**         | `bluesky`   | Experimental     | App password (with DM access)                             | No                |

Discord awaits upstream `mautrix-discord`'s migration to `bridgev2`. See the [Networks guides](/networks/) for per-network implementation status, unsupported features, and setup steps.

## Licensing

Trioditis is licensed under the **[AGPL-3.0](https://github.com/NotAKerbal/trioditis/blob/dev/LICENSE)**.

It depends on the self-hosted [Convex backend](https://github.com/get-convex/convex-backend), which is source-available under FSL-1.1-Apache-2.0 (converting to Apache-2.0 after two years) and runs unmodified as a separate service in the Docker Compose bundle.

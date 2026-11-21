---
title: Sign-in Browser
description: Architecture and security model of the isolated server-side Chromium sign-in browser for website-authenticated networks.
---

Messenger, Instagram, Google Messages, Google Voice, Slack, LinkedIn, and X authenticate through `cookies` login steps. Rather than forcing users to scrape cookies and headers out of browser DevTools, Trioditis renders the network's login page live inside the app's login stepper using an isolated server-side Chromium (`login-browser`), collects the required session values directly in memory, and submits them straight to the bridge host.

Cookies never traverse the client device, Convex, or the outbox. Manual cookie pasting remains available whenever `login-browser` isn't running or a user prefers it.

```
client ── wss /login-browser (+ ticket) ──► Caddy ──► gateway (public listener :8602)
                                                          │ redeems single-use ticket with Convex
                                                          ▼
                             bridge host  GET /v1/logins/:loginSessionId/browser
                                   │ CDP over WebSocket (one Chromium per login)
                                   ▼
                             login-browser (launcher + Chromium, LOGIN_BROWSER_TOKEN only)
                                   │ every request through per-browser egress proxy
                                   ▼
                             network website (ports 80/443, public IPs only)
```

## Security & isolation guarantees

The sign-in browser transiently sees the user's website session and typed credentials during sign-in (inherent to authenticating a bridge on the server), while enforcing strict containment:

- **Zero persistence or logging:** No video frames, URLs, or keystrokes are stored or logged. Collected cookies live only in memory until handed to the connector.
- **Ephemeral per-login Chromium & UID:** Each login spawns a dedicated Chromium process with its profile in memory (`/dev/shm`) under a unique UID from `LOGIN_BROWSER_UIDS` that is never reused for the lifetime of the container. One login cannot read another's profile or processes. On exit, `kill(-1)` as that UID reaps every descendant and wipes the profile.
- **No container secrets:** The read-only `login-browser` container holds only `LOGIN_BROWSER_TOKEN` (never passed to Chromium's environment).
- **Isolated `signin` network + egress proxy:** `login-browser` has no direct internet access and no access to Postgres, Convex, or the gateway. Every request goes through a dedicated per-browser egress proxy on the bridge host (capped at 128 connections) that allows `CONNECT`/HTTP only to ports `80` and `443` on **public IP addresses**—blocking loopback, private ranges, link-local cloud metadata, CGNAT, multicast, Azure WireServer, and any custom `BRIDGE_EGRESS_DENY` CIDRs.
- **No address bar & generation-tagged input:** Users cannot navigate arbitrarily, and every mouse/key/text event carries a 4-byte page generation counter so stale input can never land on a newly navigated document.

## Ticket-based WebSocket admission

1. The client calls `api.logins.openBrowser({ loginSessionId, stepId, sessionId })` to receive a one-time 32-byte `ticket` (stored in Convex only as SHA-256, valid 60s) and an HMAC-signed `admission` token (`<person>.<expiresAt>.<mac>`).
2. The client connects to `wss://<origin>/login-browser?admission=...` and sends `{ "type": "ticket", "ticket": "..." }` as its first WebSocket message—keeping the secret ticket out of URLs and proxy logs.
3. The gateway's public listener (`GATEWAY_PUBLIC_ADDR`, default `127.0.0.1:8602`) validates the admission HMAC before accepting, enforces per-person and global connection budgets (64 pending / 32 active viewers), redeems the ticket via `gateway.redeemSigninTicket`, and proxies raw frames between the client and the bridge host owning that login.
4. Close codes tell the UI why a session closed: `4401` (invalid/expired ticket), `4409` (step no longer active), `4503` (backend or bridge host unreachable). Idle browsers with no viewer close automatically after 2 minutes; hard lifetime cap is 20 minutes.

## Value extraction & hidden steps

The bridge host monitors the active page via Chrome DevTools Protocol (CDP) and extracts fields matching the connector's `LoginCookieField.Sources` (`cookie`, `local_storage`, `request_header`, `request_body`, or `special` via `extractJs`). Submission occurs only once every required field matches its pattern **and** the current URL matches `waitForUrlPattern` (or the step's registrable domain), preventing cross-site cookie confusion.

Steps marked `hidden: true` (such as X's automated browser token) execute headlessly on the bridge host without displaying a viewer.

## Known limits

- **Google automated-browser checks:** Google may occasionally reject headless sign-in for Google Messages or Google Voice; manual cookie paste works as a fallback.
- **Hardware passkeys:** Server-side Chromium cannot access local WebAuthn keys (virtual authenticators are enabled with zero keys so prompts never deadlock). Choose password/OTP verification or paste cookies instead.
- **Saved passwords:** Browser autofill from the user's local device isn't available inside the remote viewport; paste credentials directly (up to 4,096 chars per `text` frame).

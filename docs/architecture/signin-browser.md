# The sign-in browser

Some networks log in through their own website: Messenger, Instagram, Google Messages,
Google Voice, LinkedIn, X and Slack hand the bridge host a `cookies` login step, a page to
sign in on and the cookies, headers or values to collect from it once the person has. The
sign-in browser shows that page to the person, live, inside the login stepper. They sign in
as they would anywhere; the bridge host reads what the network needs from the browser and
submits it itself. Nothing is copied out of developer tools, and the cookies never reach the
person's device, Convex or the outbox.

The browser runs on the server, so it works the same from the web app, the desktop app and
a phone. Pasting the cookies by hand is still there, for a server without one.

```
client ── wss /login-browser, then a ticket ──► Caddy ──► gateway (public listener)
                                                              │ redeems the ticket with Convex
                                                      ▼
                                bridge host  GET /v1/logins/:loginSessionId/browser
                                      │ CDP over a websocket, one Chromium per login
                                      ▼
                                login-browser (launcher + Chromium, only its own token)
                                      │ every request through the bridge host's egress proxy
                                      ▼
                                the network's website
```

## What the person gives up

The browser shows the person's account to the server while they sign in, and the password
they type passes through it. That is more than pasting cookies, which are already enough to
use the account: the bridge host holds them, and every message, from then on. What the
server never does with it:

- Nothing from the browser is stored or logged: not frames, not page addresses, not what
  is typed. The bridge host keeps the collected values in memory only until it hands them to
  the network's connector, as it does with a pasted cookie. The connector then keeps the
  session it makes from them, exactly as it does for a pasted login (sealing.md, What else is
  stored in plaintext).
- Each login gets its own Chromium process, with its profile in memory (`/dev/shm`). The
  process is killed and its profile removed when the step ends, the login ends or the person
  leaves.
- Chromium's own sandbox needs user namespaces, which containers (and hosts that restrict them
  with AppArmor) don't allow, so it runs without it. Instead each login's Chromium runs as a
  user of its own (from `LOGIN_BROWSER_UIDS`), never used again while the container runs, with
  a profile only that user can read: a page that took over one person's browser can't read
  another's profile or reach its processes, and nothing it leaves behind can be read by a later
  login. When the login ends, that user kills everything of its own (one `kill(-1)`, so nothing
  can fork away from it, checked in `/proc`) and removes its profile; if that doesn't finish
  within 15 seconds the launcher kills what it finds of that user's itself. `pnpm dev` runs
  every browser as the developer.
- Chromium runs in its own container, `login-browser`, which holds no secret but
  `LOGIN_BROWSER_TOKEN` (which only starts browsers, and which Chromium's own environment
  doesn't get). It is on a network of its own with the bridge hosts that sign in on a website
  and nothing else, which can't reach the internet and gives the server itself no address (Docker 28's isolated gateway mode, so the installer needs Docker 28 or later); those bridge hosts refuse every
  connection from its address but to their egress proxy (below).

## Login steps

A `cookies` step (bridge-protocol.md, Logins) has two more fields:

```json
{ "cookies": { "url": "…", "fields": [], "browser": true, "hidden": false } }
```

- `browser`: the bridge host can run this step in the sign-in browser. Without it, the
  client asks for the values by hand, as before.
- `hidden`: the page needs nobody to look at it (X's browser token). With `browser`, the
  bridge host runs it by itself as soon as the step starts, and the client only says it's
  working. A hidden step without `browser` can't be done by hand either; the client says so.

## Tickets

The client asks Convex for a ticket to the current step's browser and an admission, opens a
websocket with the admission in its address and sends the ticket as its first message. The
ticket is never part of the address, which proxies in front of the server (and Caddy, when an
upstream fails) log; the admission may be logged, and is no use without the ticket.

```ts
const { ticket, admission } = await convex.mutation(api.logins.openBrowser, { loginSessionId, stepId, sessionId })
const socket = new WebSocket(`${wsOrigin}/login-browser?admission=${encodeURIComponent(admission)}`)
socket.binaryType = 'arraybuffer'
socket.onopen = () => socket.send(JSON.stringify({ type: 'ticket', ticket }))
```

`openBrowser` refuses unless the login is the caller's, still `active`, and its current
step is `stepId`, a `cookies` step with `browser`. A ticket is 32 random bytes (base64url);
Convex keeps only its SHA-256, with the login, the person, the bridge host running the login
and the step. It lasts 60 seconds and works once: the gateway redeems it
(`gateway.redeemSigninTicket`), which deletes it and checks again that the login and step are
current. Asking for a ticket deletes the person's earlier unused ones.

The admission is `<person>.<expiresAt>.<mac>`: `person` is the first 32 hex digits of the
SHA-256 of `trioditis/login-browser/<userId>`, `expiresAt` the ticket's expiry (ms), and `mac`
the base64url HMAC-SHA256, under `GATEWAY_SECRET`, of `login-browser-admission\n<person>.<expiresAt>`.
It proves a signed-in person asked for the socket, without the gateway asking Convex.

The gateway's public listener (`GATEWAY_PUBLIC_ADDR`, default `127.0.0.1:8602`) serves only
this websocket and `/healthz`. It turns away (`401`), before taking it, a socket without a
valid admission. Sockets still waiting for a ticket have a budget of their own (64, at most 2
for one person), apart from viewers' (32, at most 2 for one person, whose newest replaces
their oldest), so neither someone without an admission nor one
person can keep anyone else out, wherever they connect from. It accepts the socket, waits up to 10 seconds for the ticket
(one masked text frame of at most 1 KiB) and redeems it. It finds the bridge host by the
ticket's `hostId` in `BRIDGE_HOSTS`, never anything the client sends, and opens a websocket
to it, with a key of its own, the internal token and the ticket's person and step:

```
GET /v1/logins/:loginSessionId/browser
Authorization: Bearer <TRIODITIS_INTERNAL_TOKEN>
X-Trioditis-User-Id: <userId>
X-Trioditis-Step-Id: <stepId>
```

The bridge host refuses (`409`) unless that login is running there, is the person's, and its
current step is that `cookies` step. Once both sockets are open the gateway copies bytes both
ways and reads none of them (what the client sent after the ticket goes first). Before then,
it closes the client's socket with a code the client shows a reason for: `4401` for a ticket
that is missing, malformed, used or expired; `4409` when the host refuses the step; `4503`
when the backend or the host can't be reached.

One person watches a browser at a time: a new viewer replaces the last, which is closed. A
browser with nobody watching for 2 minutes is closed, and a later ticket starts a new one at
the step's page.

## Viewer messages

Over the websocket, the bridge host sends:

- **Binary:** a frame: the page's generation (4 bytes, big-endian), then one JPEG of the
  page at the viewport's size times its scale. The generation identifies the document shown,
  and changes whenever the page navigates or another page (a pop-up) takes its place.
- **Text**, JSON:
  - `{"type":"viewport","width":1024,"height":720,"scale":2}`: the viewport in CSS pixels
    as applied (clamped, below). Input coordinates are in this space.
  - `{"type":"page","url":"https://www.facebook.com/","loading":false}`: where the browser
    is, to show the person which site they are signing in to.
  - `{"type":"done"}`: everything was collected and has gone to the network. The next login
    step follows as usual.
  - `{"type":"error","error":"<code>"}`: the browser can't go on (`internal`;
    `unsupported` when the server has no browser; `busy` when the person already has as many
    sign-in browsers open as the launcher runs for one person); the client offers to start again or to
    paste the values by hand.

The client sends text JSON:

| Message                                                                                                                | What it does                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `{"type":"viewport","width":n,"height":n,"scale":n}`                                                                   | Resizes the page. Width 320–1600, height 320–1200, scale 1–2                                                      |
| `{"type":"mouse","event":"…","x":n,"y":n,"button":"…","buttons":n,"clickCount":n,"deltaX":n,"deltaY":n,"modifiers":n}` | `event`: `mousePressed`, `mouseReleased`, `mouseMoved`, `mouseWheel`; `button`: `none`, `left`, `middle`, `right` |
| `{"type":"key","event":"…","key":"…","code":"…","keyCode":n,"text":"…","modifiers":n}`                                 | `event`: `keyDown`, `rawKeyDown`, `keyUp`. Special keys and shortcuts                                             |
| `{"type":"text","text":"…"}`                                                                                           | Types text, as typing or pasting does (at most 4096 characters)                                                   |
| `{"type":"navigate","action":"back" \| "forward" \| "reload"}`                                                         | Moves through the page's history                                                                                  |

`mouse`, `key` and `text` also carry `"gen"`, the generation of the frame the viewer was
showing; one for any other generation is dropped, so what the person types or clicks for one
page never reaches a page that has replaced it.

`modifiers` is CDP's bit field: Alt 1, Ctrl 2, Meta 4, Shift 8. The browser runs on Linux,
so a Mac client sends Cmd as Ctrl. Anything else is ignored. The page can't be pointed
anywhere new: there is no address bar.

## Collecting the values

The bridge host fills each field of the step from the first of its sources it finds
(bridgev2's `LoginCookieField.Sources`):

| Source           | Read from                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `cookie`         | The browser's cookie of that name on `cookieDomain` or a subdomain (without one, the step page's site) |
| `local_storage`  | The current page's `localStorage` key                                                                  |
| `request_header` | That header of a request the page made, on the step page's site, to a URL matching `requestUrlRegex`   |
| `request_body`   | That field of such a request's body, parsed as JSON or a form                                          |
| `special`        | The step's `extractJs` result: it resolves an object keyed by field ID                                 |

`extractJs` runs on every page load, and its result counts for whichever fields it holds.
Values read from a cookie are percent-decoded first, as a pasted cookie is, and a field with
a `pattern` then takes only a value that matches it. Once every required field has a value
and the page's address matches `waitForUrlPattern` (or, for a step without one, is on the
step page's site, its registrable domain), the bridge host submits them to the network as
one input, exactly as a pasted step's, tells the viewer `done` and closes the browser. So a
page on another site, which may set cookies of the same names, never completes a step.

A step takes one submission, from the browser or pasted. When both come, the first wins: a
paste that arrives after the browser has submitted is accepted and dropped, so the
browser's login goes on, and a browser that finds everything after a paste was sent
submits nothing.

## Egress

Chromium reaches the web only through an egress proxy of its own on the bridge host: each
browser gets one, on a fresh port of `BRIDGE_EGRESS_BIND` (reached at `BRIDGE_EGRESS_HOST`),
with its own limit of 128 connections, and it closes with the browser, so one browser can't
use up another's or keep anything open after it's gone. The proxy takes
`CONNECT` and plain HTTP to ports 80 and 443, resolves the name itself and refuses any
address that isn't public: loopback, private, link-local (cloud metadata), CGNAT, multicast
and the like, IPv4 and IPv6, and Azure's WireServer. `BRIDGE_EGRESS_DENY` (address ranges,
comma-separated) adds any others this server's network routes somewhere local. So a page can't use the browser to reach the server's own
services or its network. A tunnel stays open at most 10 seconds after either side closes.
When the network's connector has a proxy (`META_PROXY`,
`INSTAGRAM_PROXY`), the egress proxy goes out through it, so the sign-in comes from the same
address the bridge connects from.

## The launcher

`login-browser` (`apps/bridge-host/cmd/login-browser`) starts a Chromium for each
connection to `GET /v1/browser?proxy=<url>&owner=<name>` (a websocket, with
`LOGIN_BROWSER_TOKEN`), relays
DevTools protocol messages between the socket and Chromium's `--remote-debugging-pipe`, and
kills Chromium and removes its profile when the socket closes. It runs at most
`LOGIN_BROWSER_MAX` (default 4) at once, and at most `LOGIN_BROWSER_PER_PERSON` (default 1) for
any one person, whom the bridge host names by a hash of their ID (`owner`), so one person
can't take every browser. A person past that is most likely starting again (a reload, a new
login) with an older browser still open, so their oldest is ended to make room; only if it
doesn't end in time does the launcher answer `429`, and the viewer gets `busy`. Each runs for at most 20 minutes, and on stopping it
ends each one and waits for its cleanup. Profiles go in `LOGIN_BROWSER_TMP` (default
`/dev/shm`), which must be memory-backed; `pnpm dev` runs no sign-in browser without one.
Chromium runs headless, with QUIC, background networking, downloads, file choosers and
permission prompts off. A bridge host whose browser's events back up past 128 MiB ends that
browser.

## Limits

- A page that takes over its own Chromium (a browser exploit) still can't read anyone else's
  profile, credentials or processes, but it could slow other people's sign-ins while it runs:
  the browsers share the container's process and memory limits, and their egress proxies are
  on one network. Stopping that needs per-browser cgroups or authenticated proxies; a slowed
  sign-in can be tried again, or the cookies pasted.
- Google may refuse to sign in from a browser it judges automated ("This browser or app may
  not be secure"). Pasting cookies by hand still works for Google Messages and Voice.
- Passkeys and security keys don't reach the server's browser. A page that asks for one (Google's
  "Verifying it's you") waits, still taking input, so the person chooses another way to sign in.
  The browser has WebAuthn's virtual authenticators on with none added, which is what keeps it
  from waiting on a prompt it can't show, and means it can never make a passkey.
- What the person's own browser fills in (saved passwords) isn't offered; paste it instead.
- One page is shown. A sign-in that opens a pop-up window shows the pop-up while it is open.

# Google Voice

Texts (SMS and MMS) on a Google Voice number. The bridge uses voice.google.com's own web API
with your Google account's cookies, so no phone has to be online. Calls and voicemail aren't
bridged.

|                |                                                                         |
| -------------- | ----------------------------------------------------------------------- |
| ID             | `gvoice`                                                                |
| Connector      | `go.mau.fi/mautrix-gvoice` v0.2611.0 (`pkg/connector`, `GVConnector`)   |
| Bridge host    | `apps/bridge-host/internal/networks/gvoice.go`                          |
| Maturity       | **experimental** (a later candidate in docs/PLAN.md)                    |
| Terms risk     | **Yes**: see Terms and account risk                                     |
| Operator setup | None (and no Electron helper; see Sending without the signature helper) |

## Logging in

The connector offers one flow, **`cookies`** ("Paste cookies"). The account must already
have a Google Voice number; finish setting it up at voice.google.com first, or the login ends
with "no Google Voice number".

1. In Trioditis, Settings → Accounts → Google Voice → Paste cookies.
2. In a desktop browser, open a **private window**, go to `https://voice.google.com` and
   sign in with the Google account that has the number. Wait until your messages load.
3. Open the developer tools: Chrome, Application → Storage → Cookies →
   `https://voice.google.com`; Firefox, Storage → Cookies. Copy each value into the field of
   the same name:

   | Cookie             | Domain                | Needed   |
   | ------------------ | --------------------- | -------- |
   | `SID`              | `.google.com`         | yes      |
   | `HSID`             | `.google.com`         | yes      |
   | `SSID`             | `.google.com`         | yes      |
   | `APISID`           | `.google.com`         | yes      |
   | `SAPISID`          | `.google.com`         | yes      |
   | `OSID`             | `voice.google.com`    | optional |
   | `__Secure-1PSIDTS` | `.google.com`         | optional |
   | `COMPASS`          | `clients6.google.com` | optional |

   `COMPASS` isn't listed under voice.google.com's cookies; if you want it, find it in the
   Network tab on a request to `clients6.google.com` (Cookies). Leave an optional field you
   can't find empty: it isn't sent.

   The stepper's instruction line comes from the connector and mentions "a JSON object or a
   cURL command"; Trioditis asks for each cookie on its own instead.

4. Continue. The bridge checks the account with Google and the login completes with your
   Google Voice number; there is no second step.
5. **Close the private window without signing out.** Signing out revokes those cookies.

The cookies arrive at the bridge host sealed to the bridge key (sealing.md) and are cleared
from memory once used, but the connector then keeps them (see below). When Google stops
accepting them, the login goes to "bad credentials": log in again with fresh cookies.

## What the bridge host sets

The connector's example config is loaded as defaults (`withDefaults`): 20 threads synced on
connect, display names from your Google contacts or else the number. One change:

**A text is never sent twice.** libgv repeats any request that fails with a network error or
a 5xx, up to 11 times over about two minutes (`libgv/request.go`, `MakeRequest`), sending a
text included. A send whose connection dropped after Google got it, or that hit the HTTP
client's 2-minute timeout, would go out again. The bridge host wraps each login's HTTP
transport (`gvoiceSendOnce`): a send that fails in transport or with a 5xx comes back to the
connector as a 408, which it reports as an uncertain timeout, so the send is `unknown` and
the person decides whether to send again. A send answered with a redirect comes back as a
408 too: Go's HTTP client would follow a 307 or 308 by posting the text again, and libgv
would retry a 5xx from the redirected address. (Refusing the redirect in the client instead
would fail the request with a network error, which libgv retries.) Other requests (sync,
contacts, read markers) keep libgv's retries. The connector is wrapped (`gvoiceConnector`) only to install that transport
in `LoadUserLogin`; every interface it implements is kept.

## Sending without the signature helper

Google Voice's web app signs each send with a value computed by an obfuscated Google script
(botguard, "Waa"). Upstream computes it by running **Electron** if an `electron` binary is on
`PATH` (`electron.go`, `electron.mjs`): a hidden browser window loads voice.google.com and
Google's script, and the bridge asks it for a signature per send. Without Electron the
connector sends with a placeholder (`"!"`), which is also how upstream's own Docker image
runs.

The bridge-host image doesn't include Electron, so **sends go unsigned**. Google may
rate-limit or reject unsigned sends, or count them against the account; when it rate-limits,
the send fails and bridgev2's log line for it ends `electron status: unavailable`. Receiving
isn't affected.

What carrying the helper would take, if unsigned sends turn out not to work: an `electron`
binary on `PATH` in the bridge-host image; a display for it (Electron on Linux needs X or
Wayland even for a hidden window, so Xvfb in the container); outbound access to
voice.google.com and Google's script host; and accepting that the container runs a remote,
obfuscated Google script, with that page's content-security policy stripped by the helper.
The helper writes its script to a temporary file (no message content; the signature request
carries only SHA-256 hashes of the thread, recipients and transaction ID). None of this is in
the login: the cookie step needs no JavaScript and no special fields, and the bridge host
and the desktop stepper carry it as it is.

## What it stores in plaintext

In the bridge host database, beyond bridgev2's own portal, ghost and login tables:

- **`user_login.metadata.cookies`**: **the Google account cookies you pasted**, updated from
  Google's responses. They are a signed-in Google account session, not only Google Voice:
  anyone who reads this column can act as that Google account until the cookies are revoked.
  Treat the database accordingly (encrypted disk and encrypted backups, the Phase 0 decision
  in sealing.md). Revoke them by logging out in Trioditis and signing that Google account out
  of its other sessions (Google Account → Security → Your devices).
- `user_login`: the remote name and profile are your Google Voice number; the metadata also
  holds a thread-sync token.
- `portal.metadata.participants` and `ghost.metadata.phone`: phone numbers.
- `message.metadata`: at most the Google Voice thread ID a message came from.
- `gvoice_login_prefix`: login IDs (which include the number).

No message content is stored by the connector, and nothing is written to disk except the
Electron helper's script, which isn't used here. Media is streamed through the bridge host's
media path.

**Logs.** At the default level the connector logs no message text, names or numbers. Request
URLs are logged at warn when a request fails; they carry Google's public web API key, not
your cookies.

## Terms and account risk

This is an unofficial client driving voice.google.com with your account's session cookies,
and Google actively checks for that (the signature above exists for it). Google can
rate-limit, flag or lock the Google Voice number or the whole Google account, and Google
Voice's acceptable use policy forbids automated or bulk messaging. Use it for ordinary personal
texting only, and consider whether you'd mind losing the account.

## Known limits

- Texts and pictures only: no reactions, replies, edits or typing (Google Voice has none);
  calls and voicemail aren't bridged. The connector advertises 160 characters per text and
  pictures up to 2 MiB (PNG, JPEG, GIF, BMP, TIFF).
- A new group text can have at most 7 other people.
- Unsigned sends (above).
- Live behaviour hasn't been verified: login, messages, media and history need Isaac's
  account.

## How to test

With a Google account that has a Google Voice number:

- [ ] **Connect**: log in as above, with the optional cookies left empty. The login completes
      with the number.
- [ ] **Receive**: a text from another phone to the Google Voice number arrives in the right
      chat, named from your contacts.
- [ ] **Send**: a text from Trioditis reaches the other phone once and shows as sent. Send a
      few in a row; note any rate-limit failure (and the `electron status` in the log).
- [ ] **Reply / edit / react**: not supported; check the client doesn't offer them.
- [ ] **Media**: send and receive a photo; receive a group MMS.
- [ ] **Backfill**: older messages of a chat load ("load older").
- [ ] **Read state**: reading a chat in Trioditis marks it read on voice.google.com.
- [ ] **Reconnect after restart**: restart the bridge host; texts received meanwhile arrive,
      and sending works.
- [ ] **Expired cookies**: sign the private window's session out of the Google account; the
      login shows as needing a new login, and logging in again with fresh cookies works.
- [ ] **Log out**: log out in Trioditis; the chats stop updating.

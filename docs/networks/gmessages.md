# Google Messages

SMS, MMS and RCS through the Google Messages app on an Android phone. The bridge pairs with
the app as a "Messages for web" device, so **the phone does the sending and receiving and
must stay switched on and online**; the bridge only talks to Google's relay.

|                |                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ID             | `gmessages`                                                                                                                       |
| Connector      | `go.mau.fi/mautrix-gmessages` v0.2611.0 (`pkg/connector`, `GMConnector`)                                                          |
| Bridge host    | `apps/bridge-host/internal/networks/gmessages.go`                                                                                 |
| Maturity       | **beta**. Stable is the v1 target (docs/PLAN.md), after the conformance suite and a week on the canary ledger with a real account |
| Terms risk     | No. Google Messages for web is an official feature; the bridge is one more paired device                                          |
| Operator setup | None                                                                                                                              |

## Logging in

The connector offers one flow, **`google`** ("Sign in with Google"): Google account
cookies, then an emoji tapped on the phone. Its QR flow is switched off upstream (pairing
by QR no longer works), so Trioditis doesn't offer it.

Before you start, on the phone: open Google Messages, tap your profile picture, then
**Device pairing**, and check that it is signed in to the Google account you're about to
use. Keep the app open and the phone online while you pair.

1. In Trioditis, Settings → Accounts → Google Messages → Sign in with Google. The stepper
   asks for seven cookies.
2. In a desktop browser, open a **private window** and go to the address the stepper shows
   (`https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config`).
   Sign in with that Google account.
3. Open the developer tools: Chrome, Application → Storage → Cookies →
   `https://messages.google.com`; Firefox, Storage → Cookies. Copy each value into the
   field of the same name:

   | Cookie             | Domain                | Needed   |
   | ------------------ | --------------------- | -------- |
   | `SID`              | `.google.com`         | yes      |
   | `HSID`             | `.google.com`         | yes      |
   | `SSID`             | `.google.com`         | yes      |
   | `APISID`           | `.google.com`         | yes      |
   | `SAPISID`          | `.google.com`         | yes      |
   | `OSID`             | `messages.google.com` | yes      |
   | `__Secure-1PSIDTS` | `.google.com`         | optional |

   The stepper's instruction line comes from the connector and mentions "a JSON object or a
   cURL command"; Trioditis asks for each cookie on its own instead.

4. Continue. The stepper shows an emoji. Google Messages on the phone shows a pairing
   prompt with a few emoji: tap the same one.
5. **Close the private window without signing out.** Signing out revokes those cookies and
   unpairs the bridge.

The cookies arrive at the bridge host sealed to the bridge key (sealing.md) and are cleared
from memory once used, but the connector then keeps them (see below).

Errors you may see: no devices found or phone not found (account pairing isn't on, or the
phone isn't signed in to that account), phone not responding (open the app, check its
connection, turn off battery optimisation for Messages), wrong emoji, pairing cancelled or
timed out. Each ends the login; start again.

Only one "Messages for web" session is active at a time. Opening messages.google.com in a
browser takes it over; the bridge takes it back by itself a few seconds later
(`aggressive_reconnect`, below), so don't use Messages for web in a browser while this
bridge is connected.

## What the bridge host sets

The connector's example config is loaded as defaults (`withDefaults`), with these changes:

- `device_meta.os: Trioditis`: the name the phone lists under Device pairing.
- `aggressive_reconnect: true`: upstream expects a `set-active` bot command to take the
  session back after Messages for web was opened elsewhere. Trioditis has no bot commands,
  so without this the login would sit at "bad credentials" until the bridge restarts.
- **No automatic resend.** On a send the phone answers with `FAILURE_2` or `FAILURE_3`,
  mautrix-gmessages waits and sends the same request again, up to three times
  (`handlematrix.go`, `sendRetryBackoff`), while reporting those failures as uncertain: the
  SMS may have gone out. The bridge host empties that list (a `go:linkname` to the
  connector's variable, since the connector has no option for it), so such a send is
  reported once, as `unknown`. A rename upstream would not break the build: the linkname
  would then name a variable of the bridge host's own. The bridge host checks that the list
  it empties held the connector's waits, and refuses to start Google Messages if it didn't
  (`TestGMessagesConnector` fails too).
- **A send is posted to the relay once** (`gmessagesSendOnce`, below).
- **No bridgev2 echo timeouts.** The connector asks bridgev2 to report a send as uncertain if
  the phone hasn't echoed it within a minute or so (`OutgoingMessageTimeouts`). An uncertain
  report settles the send as `unknown` and the echo that follows is dropped, so a slow phone
  (an MMS upload, a weak signal) would leave sent messages marked unknown. With them off the
  bridge host's own send timeout applies (3 minutes): the send becomes `unknown` then, and an
  echo within the next hour still records it as `sent`.

Everything else is upstream's default: 25 chats synced on connect, a phone ping every 20
minutes, display names `{{or .FullName .PhoneNumber}}`.

**Media.** The bridge-host image has no ffmpeg, so the connector converts nothing: incoming
voice notes arrive in the phone's format (often AMR or MP4 audio, not Ogg), and an outgoing
voice note must be MP4/AAC (Ogg voice notes are refused). Other media go as they are, up to
100 MiB.

## Sends and retries

A send is handed to the phone through Google's relay and confirmed when the phone echoes it
back (`Pending`), usually within seconds.

Nothing repeats a send at the transport. libgm posts a request to the relay again, same body,
after a 5xx (`libgm/http.go`, up to three attempts), and Go's HTTP client follows a 307 or
308 by posting the body again; a relay that had passed the message to the phone before
answering would get it twice. libgm builds its HTTP clients from the bridge's client
settings, and the bridge host's connector hands it settings whose transport is wrapped
(`gmessagesSendOnce`, through `WrapHTTPTransport`). Every request to the phone goes to the
same relay endpoint; the wrapper reads the request's action, which is not encrypted, and for
a `SEND_MESSAGE` replaces a 5xx or a redirect with an error that is an uncertain message
status. libgm doesn't retry a request that fails that way, the connector passes a message
status on as it is, and the send is recorded `unknown`. A relay post whose action can't be
read is treated as a send. Other requests (sync, read markers, media lookups) keep libgm's
retries. A send that fails in transport is already final in libgm and reported as uncertain
by the connector, so it is `unknown` too.

If the relay accepted a send but the phone didn't answer, the connector reports "phone not
responding" (uncertain, so `unknown`); the phone may still send it when it comes back. That
outcome is final in the bridge host: a later echo doesn't turn it into `sent`.

## What it stores in plaintext

In the bridge host database, beyond bridgev2's own portal, ghost and login tables:

- **`user_login.metadata`** holds the session: **the Google account cookies you pasted**
  (kept and refreshed from Google's responses), the pairing's auth token and keys, and the
  phone's SIM details (carrier and phone number). These cookies are a signed-in Google
  account session, not only Messages: anyone who reads this column can act as that Google
  account until the cookies are revoked. Treat the database accordingly (encrypted disk and
  encrypted backups, the Phase 0 decision in sealing.md). To revoke them, log out in
  Trioditis and remove the device under Device pairing, or sign out of all sessions in the
  Google account.
- **`message.metadata`**, per bridged message:
  - `text_hash`: an unsalted SHA-256 of the message's subject and text. It is how the
    connector notices an edit and avoids replacing media. It isn't the text, but a short or
    common message ("ok", "on my way") can be confirmed by hashing guesses. It can't be
    cleared without making later updates of that message look like edits, so it is kept as
    long as the message row.
  - `status_text`: the phone's status line for an RCS group message, e.g. "Read by Alice,
    Bob": **contact names**, for group messages with read receipts.
  - `group_receipt_sent`: participant IDs.
- **`gmessages_direct_conversation`**: phone numbers of direct chats, with their portal IDs.
- **`ghost.metadata`**: phone numbers and contact IDs (as WhatsApp's contacts are).

No message text or media is written to disk by the connector. Media is streamed through the
bridge host's media path (a file only on tmpfs; README, Media).

**Logs.** At the default level (info) the connector logs no message text. It does log, at
warn: a participant entry with no phone number (`chatinfo.go`, which can include that
person's name), the Google account email the phone names when it rejects a send because of
an account switch, and the old phone number when a direct chat's number changes. Keep the log level at warn or above in
production and treat logs as sensitive (bridge host README, Other risks).

## Known limits

- Android only, and the phone must stay online with Google Messages allowed to run in the
  background. Nothing is bridged while it is offline; it catches up when the phone is back.
- Messages for web in a browser and this bridge take the session from each other.
- No ffmpeg in the image (Media, above).
- Push isn't registered: the bridge long-polls Google's relay, as upstream does without
  push.
- Live behaviour hasn't been verified: pairing, messages, media and history need Isaac's
  phone.

## How to test

With an Android phone running Google Messages, signed in to a Google account:

- [ ] **Connect**: log in as above. The stepper reaches the emoji; tapping it on the phone
      completes the login. The phone lists "Trioditis" under Device pairing.
- [ ] **Receive**: a text from another phone arrives in the right chat, with the sender's
      name from your contacts.
- [ ] **Send**: a text from Trioditis reaches the other phone once, and shows as sent.
      Try one in an SMS chat and one in an RCS chat.
- [ ] **Reply**: in an RCS chat, a reply shows as a reply on the phone; in an SMS chat it
      arrives as plain text.
- [ ] **Edit**: not supported by SMS or RCS from the bridge; check the client doesn't offer
      it, and that a message edited on the phone (if any) updates.
- [ ] **React**: a reaction in an RCS chat shows on the phone, and one from the phone
      shows in Trioditis.
- [ ] **Media**: send and receive a photo, a video and a voice note (MP4/AAC from
      Trioditis); a group MMS photo.
- [ ] **Backfill**: older messages of a chat load ("load older").
- [ ] **Slow phone**: put the phone in airplane mode, send, wait 4 minutes (the send
      becomes unknown), turn it back on within the hour: the message goes out and becomes
      sent, once.
- [ ] **Web takeover**: open messages.google.com in a browser and choose "Use here": the
      bridge takes the session back within a minute and messages keep arriving.
- [ ] **Reconnect after restart**: restart the bridge host; messages sent meanwhile
      arrive, and sending works.
- [ ] **Log out**: log out in Trioditis; the device disappears from Device pairing.

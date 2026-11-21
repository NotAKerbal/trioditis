# LinkedIn

LinkedIn messaging (one-to-one and group conversations) through **mautrix-linkedin v0.2611.0** (`go.mau.fi/mautrix-linkedin`,
`LinkedInConnector`), built on maunium.net/go/mautrix v0.33.0, the version the connector was
released against. Network ID `linkedin`, maturity **experimental**. Connecting it uses your
browser session's cookies, which LinkedIn's terms don't allow (see Terms risk).

The bridge host's setup is `apps/bridge-host/internal/networks/linkedin.go`: the connector's
example config, with contact names written without the " (LinkedIn)" suffix (the app shows
the network's badge), redacted login responses never logged, and messages never sent twice
(see Sends and retries). There are no operator
settings: nothing to put in `.env`, and the compose service (`bridge-linkedin`, profile
`linkedin`, database `bridge_linkedin`) needs nothing beyond the shared bridge settings.

## Connecting an account

One flow is offered: **Sign in on linkedin.com** (flow ID `cookies`). The connector also has an
email-and-password flow (`password`), which isn't offered: when LinkedIn wants extra
verification it asks the person to choose between options ("Approve in LinkedIn app", "Try
another way", "Continue in browser"), and login steps can't carry a field's options to the
app yet. Offering it needs `options` added to login fields (bridge host, backend validator,
stepper) and nothing else.

In Trioditis, Settings → Accounts → LinkedIn → **Sign in on linkedin.com**. The stepper
shows LinkedIn's login page, running in the server's sign-in browser
(docs/architecture/signin-browser.md). Sign in there, finishing any verification, until the
feed loads: the bridge host reads the headers below from the feed's own requests and the
login carries on by itself.

On a server without the sign-in browser, or with **Paste cookies instead**, the headers are
copied by hand:

1. Open a **private window** in your browser and sign in at <https://www.linkedin.com/login>,
   finishing any verification it asks for, until the feed loads.
2. Open the developer tools (F12), **Network** tab, and filter for `voyager`. Click around
   (open Messaging) until requests to `https://www.linkedin.com/voyager/api/...` appear, and
   select one.
3. Under **Request headers**, copy these values into the app's fields:

   | Field in the app                                                                            | Request header                                                       | Needed                               |
   | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
   | `fi.mau.linkedin.login.cookie_header`                                                       | `cookie` (the whole value; it must contain `JSESSIONID` and `li_at`) | yes                                  |
   | `fi.mau.linkedin.login.x_li_track`                                                          | `x-li-track` (JSON, contains `clientVersion`)                        | yes                                  |
   | `fi.mau.linkedin.login.x_li_page_instance`                                                  | `x-li-page-instance` (starts `urn:li:page:`)                         | yes                                  |
   | `fi.mau.linkedin.login.header.user-agent`                                                   | `user-agent`                                                         | recommended                          |
   | `fi.mau.linkedin.login.header.sec-ch-ua`, `…-platform`, `…-mobile`, `…prefers-color-scheme` | the matching `sec-ch-*` headers                                      | optional (Firefox doesn't send them) |

4. **Close the private window without signing out** (signing out ends the session the bridge
   now uses), then press Continue.

The step's own instructions mention "a JSON object or a cURL command": that's for Beeper's
clients; in Trioditis each value goes in its own field. The app masks every cookie field.

From the terminal (dev only, no gateway): `bridge-host --network linkedin --dev-keys --user
<id> login`, which prompts for each field by ID.

## What's stored in plaintext

Nothing beyond bridgev2's own tables. The connector has no tables of its own, writes no
files, and keeps no message content in metadata, with one small exception:

- **`user_login.metadata`**: the whole LinkedIn session (the cookie jar, including `li_at`
  and `JSESSIONID`), `X-LI-Track`, the page instance, the browser headers you gave, and the
  conversation sync token and time. Anyone with the database can act as your LinkedIn
  account until the session is ended (sign out of LinkedIn everywhere, or log out in the app).
- **`portal.metadata`**: which features LinkedIn disabled for a conversation.
- **`message.metadata`**: `edit_hash`, for messages that were edited: an unsalted SHA-256 of
  the edited message's body JSON, kept to ignore repeated edit events. It isn't the text, but
  a short, guessable edited message could be confirmed by hashing guesses. It isn't bounded
  (it lives as long as the message row). `direct_media_meta` (media URLs) is only written with
  direct media, which the bridge host never enables.
- bridgev2's tables hold conversation titles and contact names, as for every network
  (docs/architecture/sealing.md, What else is stored in plaintext); a one-off KV row,
  `linkedin_legacy_timestamps_fixed`, records a migration step.

Logging at the default level (info) carries no message content or contact names. One
warning, "Message conversion resulted in empty parts", logs the message's body text, but it
only fires when the body is empty. At debug level (`--verbose`), a search that returns
nothing logs LinkedIn's raw response; never run it with `--verbose` in production.

## Sends and retries

mautrix-linkedin's HTTP layer (`linkedingo`, `DoRaw`) retries every request up to five
times after a connection error or a 502/503/504, resending the body. For a message that
would mean sending it again after its answer was lost, so the bridge host changes it for
message creation (`POST .../voyagerMessagingDashMessengerMessages?action=createMessage`,
used by sends and by a new group's first message): each one goes to LinkedIn **once**.

The bridge host wraps the connector (`linkedinConnector`) and gives each login's HTTP client
a transport (`linkedinSendOnce`) that turns a connection error, any 5xx and a redirect on
that request into a 500 Internal Server Error, which `DoRaw` doesn't retry. The connector
reports a 5xx as a server error it isn't sure of, so the send is recorded as `unknown` and
the person decides whether to send it again. A 4xx is LinkedIn's own refusal and stays a
failure. Adding and taking away a reaction (`reactWithEmoji`, `unreactWithEmoji`) go
through the same transport, since a repeat could undo what the person did meanwhile on
another device; one that isn't confirmed is never reported as done
(`TestLinkedInReactionIsNotRepeated`). Every other request (edits, sync, media) keeps the
connector's retries, which can't send a message twice. The client's `http.Client` is private to `linkedingo`, so
the bridge host reaches it by reflection in one place (`linkedinHTTPClient`); if an upgrade
moves or retypes the field, logins fail to load rather than send without the transport, and
`TestLinkedInSendOnceReachesTheClient` fails. `TestLinkedInSendIsNotRepeated` sends through
the connector against each ambiguous answer and checks that it reaches LinkedIn once and is
reported as uncertain.

## Known limits

- Voice messages from the app need `ffmpeg`, which the bridge host image doesn't include, so
  they're refused; other media works (20 MiB limit) through the bridge host's tmpfs files.
- Formatting is dropped except mentions; text up to 8000 characters.
- Only the 10 most recently active conversations get a chat when the account connects
  (`sync.create_limit`); older ones appear when they get a new message.
- The session lasts as long as LinkedIn keeps it (typically months). When it ends, the login
  reports bad credentials and you connect again.

## Terms risk

`termsRisk: true`. LinkedIn's User Agreement forbids automated access and third-party
software that scrapes or automates the site; using a browser session from a server can get the
account restricted or banned. LinkedIn may also ask for re-verification when it sees the
session used from the server's IP address.

## How to test

With Isaac's account, in the desktop app against a real deployment (or `login` from the
terminal plus `inspect` with dev keys):

- [ ] **Connect**: Paste cookies, with only the three required fields and then again with the
      user agent; the login completes and shows as connected.
- [ ] **Receive**: a message from another account arrives in its chat, with the sender's name.
- [ ] **Send**: a message from the app arrives on linkedin.com; its status reaches `sent`.
- [ ] **Reply**: replying to a message shows as a reply on LinkedIn, and a reply made on
      LinkedIn shows its target in the app.
- [ ] **Edit**: an edit on LinkedIn updates the message in the app; an edit from the app
      updates it on LinkedIn.
- [ ] **React**: a reaction each way; removing it each way.
- [ ] **Delete**: deleting (recalling) a message each way.
- [ ] **Media**: an image and a PDF each way; a voice message from the app is refused.
- [ ] **Backfill**: recent history of the 10 newest conversations appears after connecting.
- [ ] **Group chat**: a message in a group arrives, with the group's title.
- [ ] **Reconnect after restart**: restart `bridge-linkedin`; messages sent meanwhile arrive.
- [ ] **Log out**: logging out in the app ends the login and signs that session out of
      LinkedIn (the connector calls LinkedIn's logout); other sessions stay signed in.

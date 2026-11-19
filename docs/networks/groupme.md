# GroupMe

GroupMe (Microsoft's group messaging app) through Beeper's bridgev2 connector. It is
**experimental** in Trioditis: the connector is a development bridge, pinned to an untagged
commit, and nothing here has been tried with a real account yet.

## Connector

- **Module:** `github.com/beeper/groupme`, package `pkg/connector` (`GMConnector`), at
  pseudo-version `v0.0.0-20261118135138-42e6cd46dac3` (an untagged commit of 2026-11-18). Its
  GroupMe API client is `github.com/beeper/groupme-lib` at
  `v0.2.1-0.20261113165139-6773c3ac00ad`.
- **Not a mautrix release.** It was written against mautrix `v0.31.1-0.20261014100333-d27bb75b1649`;
  the bridge host builds it on `v0.33.0`. It compiles, and every optional bridgev2 interface it
  implements is checked at compile time with a `var _` assertion, so none silently drops out
  on the newer version. Its config upgrader isn't used: the host loads its example config as
  defaults (`withDefaults`).
- **Maturity, by its own README:** its authors verified group and DM text, replies,
  reactions, initial history, edits, typing, receipts and DM deletion live, on a dedicated
  self-hosted Beeper setup. Media validation is incomplete.
- **What it does:** text (formatting flattened to plain text, 1000 characters), replies,
  native emoji reactions (one per person), edits both ways within GroupMe's 15-minute window,
  deletes, typing, read receipts (DM seen receipts too), images, GIFs, videos, locations and
  group files (25 MiB for images and video, 50 MB for files; files aren't allowed in DMs),
  incoming polls (but see Known limits: the bridge host drops open ones), contact list, starting a DM with a contact, blocking in DMs,
  deleting a DM for yourself, DM message requests, and backfill (initial history, catch-up
  after downtime and older pages; GroupMe pages hold 100 group or 20 DM messages).
- **How it receives:** GroupMe's push service, Bayeux (Faye) over a WebSocket to
  `push.groupme.com`, subscribed to the account's user channel and to every group and DM.
  Each time the user channel subscribes (at login, start-up and every reconnect) it lists the
  chats and queues a resync, so bridgev2 backfills what was missed (the host has backfill on).
  While connected it also lists the chats every 5 minutes and resyncs any whose newest
  message didn't arrive over push, and refreshes each active poll once a minute.
- **Start and stop:** each login's session runs on the bridge's background context.
  `Disconnect` (called by bridgev2 when the host stops, and before a re-login) cancels it and
  waits for the push connection, the reconnect checks and the poll refresh to finish, so it
  stops with the host. The push connection reconnects by itself with backoff up to a minute;
  a rejected token ends the session and reports `bad_credentials`.

### What the bridge host sets

- `New` wraps the connector (`groupmeConnector`) only to keep the `*bridgev2.Bridge` from
  `Init`, which the content sweep below needs for the database. Every other method is the
  connector's own, so bridgev2's optional-interface checks see the same connector.
- `Background` runs the content sweep (see What it keeps in plaintext).
- No operator settings. GroupMe needs no API key or app registration, so there are no
  environment variables, nothing for the installer to write and nothing extra in the compose
  service. The connector's one setting, `disable_poll_polling`, stays `false` (active polls
  are refreshed).
- Direct media stays off (the host always reuploads media into its encrypted store), and the
  connector's FCM push registration is never called (the host doesn't use bridgev2 push).

## Logging in

The connector has three flows. The client offers two:

| Flow ID        | Kind   | First step                                                           |
| -------------- | ------ | -------------------------------------------------------------------- |
| `access-token` | `form` | One `token` field: paste a GroupMe access token.                     |
| `password`     | `form` | `username` (email or phone number) and `password`; then maybe a code |
| `web`          | —      | Not offered by the client (below).                                   |

**Access token (recommended).** Either:

1. Sign in at <https://web.groupme.com/> in Chrome (or any browser with developer tools).
   Open DevTools, then **Application**, **Local Storage**, `https://web.groupme.com`, and copy
   the value of `access_token`. This works for accounts that sign in with Google, Microsoft or
   Apple too.
2. Or sign in at <https://dev.groupme.com/> and click **Access Token** at the top right.

Paste it into the **Access token** field. The connector checks it against GroupMe (`/users/me`)
and the login completes.

**Email or phone and password.** Enter the email or phone number (with country code, like
`+1…`) and the GroupMe password. If the account has two-step verification, GroupMe sends an
SMS code and the next step asks for it (`code`, a `2fa_code` field). Accounts that sign in
with Google, Microsoft or Apple have no GroupMe password: set one first at
<https://web.groupme.com/forgot_password>, or use the access token.

**Why not `web`.** That flow is a `cookies` step meant for an embedded browser that reads
`access_token` from the page's local storage (or a `token` cookie, or the `X-Access-Token`
request header). The bridge host forwards only the field ID, and the desktop stepper has no
embedded browser: it would ask for a cookie called `token`, which is the same value as the
access token but harder to find. The `access-token` flow asks for that value with the right
instructions. The bridge host's terminal login still uses `web` when no `--flow` is given.

From the terminal (dev keys, no gateway). Flags go before the command:

```sh
bridge-host --network groupme --dev-keys --data /tmp/gm-try --user isaac --flow access-token login
```

**Logging out** deletes the login and its token from the database. It doesn't revoke the
token at GroupMe, which doesn't expire on its own.

### Terms

`termsRisk` is false. GroupMe publishes an API for third-party apps that act on a person's
own account with their access token (dev.groupme.com), and the `access-token` flow uses that
kind of token. No bans for unofficial GroupMe clients are known. Two caveats: the connector
also calls undocumented endpoints the web and Android apps use (edits, reactions, read
receipts, DM deletion), and the `password` flow signs in as the GroupMe Android app (its app ID
and request signature) to get a token. If that matters, use the access token.

## What it keeps in plaintext

Beyond bridgev2's own tables (chat names in `portal`, contact names in `ghost`, the account's
name in `user_login`; see docs/architecture/sealing.md, What else is stored in plaintext):

- **Message content in `message.metadata`, bounded.** For every message (incoming, sent,
  backfilled or edited) the connector keeps `native_content`: the message's text and its
  GroupMe attachments (media URLs, file IDs, location coordinates and name, mention user IDs,
  reply IDs). It uses it only to resend a message's attachments unchanged when the message is
  edited, and to recognize the echo of its own edit. GroupMe refuses edits after 15 minutes,
  so the bridge host removes `native_content` from every message whose timestamp is more than
  30 minutes old, at start-up and every 5 minutes (`internal/networks/groupme.go`). While
  sweeps succeed, a message's text stays in the database at most about 35 minutes after it was
  sent; a backfilled old message, until the next sweep after it is imported. A row written
  again later (an edit within the window) is caught by the next sweep. A failed sweep logs only
  the error's type and is retried 5 minutes later; nothing sweeps while the host is stopped,
  and the first sweep at start-up catches up. The rest of the metadata (edit revision and
  time, poll IDs) is kept: it holds no content.
  - Without the copy, an outbound edit fetches the original message from GroupMe instead
    (the connector's own fallback), and an incoming edit is converted from GroupMe's copy.
    Neither can happen past the window anyway.
- **`user_login.metadata`:** the GroupMe access token (a credential, like other connectors'
  session data), the GroupMe user ID, and active polls (poll and message IDs, expiry, and
  which voter IDs chose which option IDs; no titles).
- **`portal.metadata`:** chat type, parent group ID (for subgroups) and IDs of GroupMe bots
  seen in the chat. **`message.metadata`** also holds poll IDs and a map from the client's
  poll answer IDs to GroupMe option IDs.
- **Nothing else on disk:** no tables, database upgrades, files or caches of its own.
- **Logs:** no message content at info level. Two warnings carry a little: a location
  attachment whose coordinates don't parse logs the coordinates, and a poll that can't be
  fetched logs its poll ID. Login failures log GroupMe's error code and message, never the
  token or password. Connection errors in bridge states stay in the process: the host
  forwards only a code.

## Known limits

- **Editing a media caption fails.** The connector reads the original event back
  (`Bot.GetEvent`) to check the media isn't being replaced, and the bridge host keeps no event
  content, so the edit fails with an error. Text edits work.
- Formatting is flattened to plain text; generic files can't be sent in DMs.
- Reactions: GroupMe pushes reaction changes reliably only for the account's own messages.
  Others are picked up from the recent page refreshed at each reconnect, or with history.
- Typing from Trioditis may stop showing after 5 seconds (GroupMe pulses typing; bridgev2
  only forwards start and stop).
- GroupMe's `source_guid` deduplicates sends only briefly. A send with no clear outcome is
  marked `unknown` and never retried.
- GroupMe timestamps have second precision, so messages sharing the backfill boundary's
  second may be missed.
- **Open polls don't arrive.** The connector turns a new, open GroupMe poll into a Matrix
  poll-start event (with a text fallback listing the options), and the bridge host drops poll
  events: they aren't part of Phase 0 (`internal/connector/intent.go`). Polls it can't make
  interactive, poll reminders and results arrive as text. Creating or voting in polls from
  Trioditis isn't possible either.
- The sweep's PostgreSQL query (`metadata - 'native_content'`) is covered by
  `TestGroupMeContentSweep` only when `TRIODITIS_TEST_POSTGRES_URI` is set; it has run on
  SQLite only so far.

## How to test

With a real GroupMe account and a second account (or a friend) to talk to:

- [ ] **Connect** with `access-token`; the account shows as connected. Try `password` too
      (and the SMS code, if the account has two-step verification).
- [ ] **Receive** a group message and a DM; both chats appear with the right names.
- [ ] **Send** text to a group and a DM; it arrives in GroupMe once.
- [ ] **Reply** both ways.
- [ ] **Edit** both ways within 15 minutes; an edit after 15 minutes is refused.
- [ ] **React** both ways; remove a reaction.
- [ ] **Media:** receive and send an image, a GIF and a video; send a file to a group; a file
      to a DM is refused.
- [ ] **Backfill:** a new login brings in recent history; older history loads on scroll.
- [ ] **Reconnect after restart:** stop the host, send messages from GroupMe, start it; the
      missed messages arrive in order.
- [ ] **Plaintext sweep:** 35 minutes after a message, its text is gone from the database
      (`SELECT metadata FROM message` shows no `native_content`).
- [ ] **Log out:** the login disappears and nothing more arrives.

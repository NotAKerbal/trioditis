# Messenger (`meta`)

Facebook Messenger chats, one-to-one and group, encrypted and not. Maturity **beta**;
connecting it risks the account under Meta's terms (`termsRisk`).

- Connector: `go.mau.fi/mautrix-meta` **v0.2611.0** (mautrix-meta v26.11), package
  `pkg/connector`, `MetaConnector`. Set up in
  `apps/bridge-host/internal/networks/meta.go`.
- The same module has Instagram as a separate connector (`pkg/igconnector`), run as its own
  network; see [instagram.md](instagram.md).
- `apps/bridge-host/go.mod` replaces `github.com/imroc/req/v3` with
  `github.com/beeper/req/v3 v3.0.0-20260925135712-b49593750e56`, exactly the fork
  mautrix-meta v0.2611.0's own `go.mod` names.
- Messenger's encrypted chats run on whatsmeow (Meta's encrypted Messenger uses the
  WhatsApp protocol), in the same database as everything else.

mautrix-meta used to have a `mode` setting (facebook, facebook-tor, messenger, instagram).
v26.11 has none: the platform follows the login flow, and Instagram is a different
connector, so each network ID gets the right one by construction. The two connectors share
one package-level piece of state, the media download client in `msgconv/mediadl`
(`SetHTTP`, `SetProxy`), which each sets at start. Messenger and Instagram always run as
separate bridge host processes (one network per process), so neither sees the other's.

## Connecting your account

Messenger connects with the cookies of a signed-in browser session. Two flows are offered;
use whichever site you sign in to:

| Flow ID     | In Trioditis               | Sign in at                                    | Cookies                |
| ----------- | -------------------------- | --------------------------------------------- | ---------------------- |
| `facebook`  | Cookies from facebook.com  | `https://www.facebook.com/`                   | `xs`, `c_user`, `datr` |
| `messenger` | Cookies from messenger.com | `https://www.messenger.com/?no_redirect=true` | `xs`, `c_user`, `datr` |

All three cookies are required. To connect:

1. In a desktop browser (Chrome or Firefox), open a private window and sign in at the
   address above. Finish any security check or two-factor prompt Meta shows there first.
   Open your messages once so the session is fully set up.
2. Open the developer tools: Chrome, **Application → Storage → Cookies →
   https://www.facebook.com** (or messenger.com); Firefox, **Storage → Cookies**.
3. In Trioditis, **Settings → Accounts**, choose **Messenger, Cookies from facebook.com**
   (or messenger.com), accept the terms warning, and paste the values of `xs`, `c_user`
   and `datr` into their fields, exactly as the browser shows them (`xs` contains `%3A`;
   leave it encoded). The step's first line comes from mautrix-meta and talks about a JSON
   object or a cURL command: ignore it, the stepper asks for each cookie on its own.
4. Close the private window **without logging out**. Logging out ends the session the
   cookies belong to, and the bridge is logged out with it.

The login completes as soon as Meta accepts the cookies and the inbox loads; chats then
appear as they sync. The browser's user agent doesn't have to match: mautrix-meta always
connects as desktop Chrome on Linux.

From the terminal, for trying it without the app (flags go before `login`):

```sh
./bin/bridge-host --network meta --dev-keys --user isaac --flow facebook login
```

It prompts for `xs`, `c_user` and `datr` in turn.

### Flows not offered

mautrix-meta also has `messenger-lite` and `messenger-lite-android`, username-and-password
logins through Meta's mobile login pages. They aren't in `NETWORK_INFO`: after the
password they can ask for a choice from a list, a captcha image, or a reCAPTCHA or Google
sign-in run in an embedded browser with a script that reads the result, and can offer to
cancel a step. The login protocol carries none of that (a field has no options, a cookie
step has no script or URL to wait for, and there is no step cancel), so those logins would
stall for many accounts.

Restoring encrypted history (`e2ee_backfill`) is turned off in code: it adds a step asking
for the Messenger secure-storage PIN that may be left empty, and the stepper can't show an
optional field. Encrypted chats still bridge from the moment of login; only their older
history isn't fetched.

## Operator settings

| Variable     | Default | Meaning                                                                                                                                                                                                        |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_PROXY` | none    | An `http://`, `https://` or `socks5://` URL Messenger connects through: login and the Messenger connection, not media or the encrypted-chat connection. A value that isn't one stops the bridge host at start. |

Meta is quick to challenge sign-ins from data-centre addresses. A server on a home
connection needs no proxy; one in a data centre may need a residential proxy near where
you normally sign in. The installer doesn't write it: add `META_PROXY=…` to `deploy/.env`
by hand (backups keep it) and restart the `bridge-meta` service.

Everything else is mautrix-meta's default (its `example-config.yaml`), notably:

- `thread_backfill.batch_count: -1`: after login, every older conversation is fetched, a
  page every 2 s, and each becomes a chat.
- `cache_connection_state: false`: the session's page state is fetched again at each
  start rather than kept in the database.
- `marketplace_space: true`, `send_presence_on_typing: false`,
  `disable_view_once: false`, reconnect at most hourly and refresh every 20 hours.

## What it keeps in plaintext

Beyond bridgev2's own tables (docs/architecture/sealing.md, What else is stored in
plaintext), in the `bridge_meta` database:

| Where                                                                                              | What                                                                                                                                                                                                                                                            | Bounded by                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsmeow_event_buffer`                                                                           | Each incoming encrypted Messenger message, decrypted (content included), from decryption until it is journaled sealed, exactly as for WhatsApp: mautrix-meta turns the buffer on because the bridge host handles events synchronously (`PortalEventBuffer: 0`). | Cleared by whatsmeow once handled. A row left behind (a crash, a failed clear) is deleted by the bridge host's sweep (`wabuffer`, the network's `Background`) once past 14 days: at start and hourly. |
| `message.metadata` (bridgev2's table, mautrix-meta's JSON)                                         | For a poll: its question and option text (`poll_question`, `poll_answers`) and who voted for what. Polls aren't shown in Trioditis yet, but the row is still written.                                                                                           | Not bounded: kept for the message's life, since vote changes are reconciled against it. Deleted with the chat.                                                                                        |
| `user_login.metadata`                                                                              | The session cookies (`xs`, `c_user`, `datr` and any Meta sets later), push keys, and the encrypted-chat device ID. Credentials, not content: anyone who reads them can use the session.                                                                         | Deleted at logout (the session itself stays valid at Meta until it is ended there).                                                                                                                   |
| other `whatsmeow_*` tables                                                                         | The encrypted chats' keys and sessions; `whatsmeow_contacts` can hold names whatsmeow learns. `whatsmeow_retry_buffer` stays empty (mautrix-meta doesn't turn its outgoing store on).                                                                           | Deleted with the device at logout.                                                                                                                                                                    |
| `meta_thread`, `meta_hybrid_thread`, `meta_thread_cutover`, `meta_poll`, `meta_reconnection_state` | IDs and thread mappings only. The reconnection state (session tokens and your own profile name) isn't written while `cache_connection_state` is off.                                                                                                            | Deleted with the login or chat.                                                                                                                                                                       |

In memory only: the last 20 minutes of bridged media parts, captions included, so a caption
edit keeps its media (`mediaeditcache.go`). An edit to an older one, or after a restart,
can't look the media up (the bridge host's `GetEvent` refuses, as it keeps no content) and
is bridged as text.

Logs: the bridge host logs at info, where mautrix-meta logs IDs, not content. A few
warnings include raw Meta responses that can hold message text: a send whose response has
no message ID, a refused group creation, and the protocol decoder's warnings about fields
or steps it doesn't know. The decoder logs through zerolog's global logger, and adds the raw
arguments only when that logger is at trace, which it is until something sets it; the
bridge host sets it to its own logger at start, so they are left out. Compose keeps at most
3 × 10 MB of logs per service.

## Known limits

- **Terms of service.** Meta doesn't allow unofficial clients; an account using one can be
  checkpointed or, rarely, disabled. Use an account you can afford to have challenged.
- **Sends.** For unencrypted chats mautrix-meta retries a failed send up to five times
  itself, with the same offline threading ID, which Meta uses to recognize a repeat. If an
  attempt may have reached Meta and the last one fails, it reports the outcome as
  uncertain, and the bridge host records the send as `unknown` and doesn't retry it.
- **Encrypted history** isn't restored (see above); unencrypted history is.
- **Polls, calls and other non-message events** aren't shown in Phase 0.
- Meta logs the session out now and then (a changed password, a security check). The
  account then shows as needing sign-in; connect again with fresh cookies.

## How to test

With a Messenger account that has an encrypted one-to-one chat, an unencrypted group, and a
friend on another device:

- [ ] **Connect** with the `facebook` flow; the login completes and chats start appearing.
      Try `messenger` too if you use messenger.com.
- [ ] **Receive** a text in an encrypted chat and in a group; both arrive, in order.
- [ ] **Send** a text from Trioditis to both; the friend sees them once each.
- [ ] **Reply** to a message, both ways; the reply points at the right message.
- [ ] **Edit** a sent message within 15 minutes; the friend sees the edit. Edit a received
      one on the phone; Trioditis shows it.
- [ ] **React** and remove the reaction, both ways.
- [ ] **Media**: a photo, a video, a voice message and a file, both ways; a caption edit
      on a photo keeps the photo.
- [ ] **Backfill**: older conversations appear over the first minutes; an older unencrypted
      chat shows recent history. Encrypted chats start at the login.
- [ ] **Reconnect after restart**: restart `bridge-meta`; it reconnects without a new
      login, and a message sent meanwhile arrives.
- [ ] **Log out** from Trioditis; the account disappears and no more messages arrive.
      mautrix-meta forgets the cookies and the encrypted-chat device but doesn't sign the
      session out at Meta: end it under Facebook's **Settings → Security and login →
      Where you're logged in** too.
- [ ] Afterwards, in the `bridge_meta` database, once messages have settled:
      `SELECT count(*) FROM whatsmeow_event_buffer WHERE plaintext IS NOT NULL` is 0.

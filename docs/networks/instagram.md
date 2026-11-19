# Instagram (`instagram`)

Instagram direct messages, one-to-one and group. Maturity **beta**; connecting it risks the
account under Meta's terms (`termsRisk`).

- Connector: `go.mau.fi/mautrix-meta` **v0.2611.0** (mautrix-meta v26.11; Meta's docs call
  this bridge mautrix-instagram), package `pkg/igconnector`, `IGConnector`. Set up in
  `apps/bridge-host/internal/networks/instagram.go`.
- It shares the module with Messenger ([meta.md](meta.md)), including the
  `github.com/beeper/req/v3` fork `apps/bridge-host/go.mod` pins, and one piece of
  package-level state, the media download client (`msgconv/mediadl`). The two always run
  as separate bridge host processes, so they never share it.
- Unlike Messenger, it doesn't use whatsmeow: there is no decrypted-event buffer, and
  Instagram's end-to-end encrypted chats aren't bridged.

## Connecting your account

Instagram connects with the cookies of a signed-in browser session, flow `instagram`
(**Cookies from instagram.com**):

| Cookie       | Needed                 |
| ------------ | ---------------------- |
| `sessionid`  | yes                    |
| `csrftoken`  | yes                    |
| `ds_user_id` | yes                    |
| `rur`        | if your browser has it |
| `shbid`      | if your browser has it |
| `shbts`      | if your browser has it |
| `mid`        | if your browser has it |
| `ig_did`     | if your browser has it |

1. In a desktop browser (Chrome or Firefox), open a private window and sign in at
   `https://www.instagram.com/accounts/login/`. Finish any security check Instagram shows
   there first, then open your inbox (instagram.com/direct/inbox) once.
2. Open the developer tools: Chrome, **Application → Storage → Cookies →
   https://www.instagram.com**; Firefox, **Storage → Cookies**.
3. In Trioditis, **Settings → Accounts**, choose **Instagram, Cookies from
   instagram.com**, accept the terms warning, and paste each value into its field as the
   browser shows it. Leave a cookie's field empty if the browser doesn't have it; the
   optional ones help Instagram route the session but aren't required. The step's first line comes from mautrix-meta
   and talks about a JSON object or a cURL command: ignore it, the stepper asks for each
   cookie on its own.
4. Close the private window **without logging out**: logging out ends the session the
   cookies belong to.

The login completes as soon as Instagram accepts the cookies and the inbox loads.

From the terminal, for trying it without the app (flags go before `login`; press Enter to
skip an optional cookie):

```sh
./bin/bridge-host --network instagram --dev-keys --user isaac --flow instagram login
```

Without `--flow` the terminal starts mautrix-meta's first flow, `android`, which asks for a
username and password instead (see below).

### Flows not offered

mautrix-meta also has `android` and `instagram-password`, username-and-password logins
through Instagram's Android and web APIs. They aren't in `NETWORK_INFO`: after the password
they can ask to choose a verification method from a list, to approve the login on another
device with a cancel option, or to solve a CAPTCHA or another check in an embedded browser
with a script that reads the result. The login protocol carries none of that (a field has
no options, a cookie step has no script or URL to wait for, and there is no step cancel),
so those logins would stall for many accounts.

## Operator settings

| Variable          | Default | Meaning                                                                                                                                                              |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_PROXY` | none    | An `http://`, `https://` or `socks5://` URL Instagram connects through (login and the connection; not media). A value that isn't one stops the bridge host at start. |

Instagram is quick to challenge sign-ins from data-centre addresses. A server on a home
connection needs no proxy; one in a data centre may need a residential proxy near where
you normally sign in. The installer doesn't write it: add `INSTAGRAM_PROXY=…` to
`deploy/.env` by hand (backups keep it) and restart the `bridge-instagram` service.

Everything else is mautrix-meta's default (its `pkg/igconnector/example-config.yaml`),
notably:

- `thread_backfill.batch_count: 0`: only the chats in the inbox's first page at login, and
  any with new activity later, become chats; older conversations aren't paged through.
- `disable_xma_backfill: true`: a shared post, reel or story in fetched history is shown
  as a link rather than downloaded (fewer requests to Instagram; see plaintext below).
  New ones are downloaded.
- `cache_connection_state: true`: the session's page state is kept so a restart doesn't
  reload Instagram's web page (see plaintext below).
- `disable_typing: false` (typing needs two extra connections per login),
  `disable_view_once: false`, reconnect at most hourly and refresh every 20 hours.

## What it keeps in plaintext

Beyond bridgev2's own tables (docs/architecture/sealing.md, What else is stored in
plaintext), in the `bridge_instagram` database:

| Where                                                                                                       | What                                                                                                                                                                                                                                         | Bounded by                                                                  |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `message.metadata` (bridgev2's table, mautrix-meta's JSON)                                                  | For a shared post, reel or story in fetched history that wasn't downloaded (`disable_xma_backfill`): its instagram.com URL and media ID (`xma_fetch_meta`), kept so it could be fetched later on request. Trioditis never asks, so it stays. | Not bounded: kept for the message's life. Deleted with the chat.            |
| `user_login.metadata`                                                                                       | The session cookies and, for a password login, Instagram's app session token. Credentials, not content: anyone who reads them can use the session.                                                                                           | Deleted at logout (the session stays valid at Instagram until ended there). |
| `meta_reconnection_state`                                                                                   | The page state from loading Instagram: session tokens and your own profile (name, username), no messages or other people's names. Written at login and kept while `cache_connection_state` is on.                                            | Deleted with the login; not used once more than 24 hours old.               |
| `meta_instagram_login_device`                                                                               | Only after a password login: the app identity Instagram was told (device IDs and a signing key).                                                                                                                                             | Deleted with the bridge user.                                               |
| `meta_instagram_*` ID tables, `meta_instagram_reaction`, `meta_instagram_seq_id`, `meta_instagram_web_push` | IDs, sequence numbers and timestamps only.                                                                                                                                                                                                   | Deleted with the login or chat.                                             |

Logs: the bridge host logs at info, where mautrix-meta logs IDs, not content. Its warnings
about frames it doesn't expect (`dgw` socket) and refused uploads can include raw
responses. The protocol decoder, shared with Messenger, logs through zerolog's global logger
and attaches raw data, message text included, to its warnings about opcodes and fields it
doesn't know. The bridge host's global logger keeps only those warnings' text and safe
fields (type and field names, indexes, IDs), drops the rest and never logs below warn; see
docs/networks/meta.md (What it keeps in plaintext) for the details. Compose keeps at most 3 × 10 MB of logs per
service.

## Known limits

- **Terms of service.** Meta doesn't allow unofficial clients; an account using one can be
  challenged, rate limited or, rarely, suspended. Use an account you can afford to have
  challenged.
- **Encrypted chats** (Instagram's optional end-to-end encrypted DMs) aren't bridged.
- **Older conversations** beyond the inbox's first page aren't fetched.
- Polls, calls and other non-message events aren't shown in Phase 0.
- Instagram logs the session out now and then; the account then shows as needing sign-in.
  Connect again with fresh cookies.

## How to test

With an Instagram account, a friend on another device, one one-to-one chat and one group:

- [ ] **Connect** with the cookie flow, leaving any optional cookie your browser doesn't
      have empty; the login completes and recent chats appear.
- [ ] **Receive** a text in the one-to-one chat and in the group; both arrive, in order.
- [ ] **Send** a text from Trioditis to both; the friend sees them once each.
- [ ] **Reply** to a message, both ways.
- [ ] **Edit** a sent message; the friend sees the edit, and an edit made on the phone shows
      in Trioditis.
- [ ] **React** and remove the reaction, both ways.
- [ ] **Media**: a photo, a video and a voice message both ways; a reel shared from the
      phone arrives as media.
- [ ] **Backfill**: an existing chat shows its recent history; a reel shared in that
      history shows as a link.
- [ ] **Reconnect after restart**: restart `bridge-instagram`; it reconnects without a new
      login, and a message sent meanwhile arrives.
- [ ] **Log out** from Trioditis; the account disappears and no more messages arrive. End
      the session under Instagram's **Settings → Accounts Center → Password and security →
      Where you're logged in** as well: mautrix-meta doesn't sign it out at Instagram.

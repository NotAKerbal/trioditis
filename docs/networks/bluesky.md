# Bluesky

Bluesky direct messages (`chat.bsky`) through **mautrix-bluesky v0.2510.0**
(`go.mau.fi/mautrix-bluesky`, `BlueskyConnector`). Network ID `bluesky`, maturity
**experimental**. It logs in with an **app password**, which Bluesky provides for exactly this,
so there's no terms risk (`termsRisk: false`).

The connector was released against maunium.net/go/mautrix v0.25.2; the bridge host runs
v0.33.0. Checked for breaks that still compile: the connector implements only the base
interfaces plus backfill and read receipts, all still with the v0.33 signatures; it defines
no remote event types of its own (only `simplevent`), has no database tables or upgrades, and
its config upgrader copies only `displayname_template`. Its indigo client (pinned at
2025-10-14) skips chat log entries of types it doesn't know rather than failing the poll.

The bridge host's setup is `apps/bridge-host/internal/networks/bluesky.go`. It wraps the
connector with three changes:

- **Sends are never retried.** The connector's HTTP client (indigo's `RobustHTTPClient`)
  retries every request, body and all, after a connection error or a 5xx, so a sent message
  whose answer was lost would be sent again (up to four times in all; the test
  `TestBlueskySendsAreNotRetried` checks both ways). The bridge host's wrapper keeps those
  retries for reads (GET, HEAD) and sends everything else (messages, read markers, session
  refreshes) once; an ambiguous send is then recorded `unknown` by the bridge host, as for
  every network.
- **The login form is tidied**: the server field is used as a host name, so `https://` and a
  trailing `/` are removed and a blank server means `bsky.social`; a leading `@` is removed
  from the handle.
- Contact names are the display name, or the handle when there is none, without the
  " (Bluesky)" suffix (the app shows the network's badge).

There are no operator settings: nothing to put in `.env`, and the compose service
(`bridge-bluesky`, profile `bluesky`, database `bridge_bluesky`) needs nothing beyond the
shared bridge settings.

## Connecting an account

One flow: **App password** (flow ID `password`), a form with three fields.

1. In Bluesky, open **Settings → Privacy and security → App passwords → Add app password**.
   Name it (say, "Trioditis") and **tick "Allow access to your direct messages"**; without
   that, the login succeeds but every chat request is refused. Copy the password
   (`xxxx-xxxx-xxxx-xxxx`).
2. In the app, connect Bluesky and fill in:
   - **Server**: `bsky.social`, unless your account is on its own PDS (then its host name).
   - **Username or email**: your handle (`you.bsky.social`) or account email.
   - **Password**: the app password (the field is masked).

Your main password works too, but not with email two-factor sign-in turned on (the connector
has no step for the emailed code), and it gives the bridge full control of the account; use an
app password. You can revoke it in the same settings page at any time, which ends the login.

From the terminal (dev only, no gateway): `bridge-host --network bluesky --dev-keys --user <id>
login` prompts for `Server`, `Username or email` and `Password` (the terminal echoes what you
type).

## What's stored in plaintext

Nothing beyond bridgev2's own tables. The connector has no tables of its own, writes no
files, and keeps no message content in metadata:

- **`user_login.metadata`**: the access and refresh tokens (JWTs), the handle, DID and PDS
  host, and the chat log cursor. With the database, someone could use the account's DMs until
  the app password is revoked.
- **`user_login.remote_profile`**: the handle and the **account email** (the connector stores
  the email the server returns at login).
- bridgev2's tables hold contact names (as for every network; docs/architecture/sealing.md,
  What else is stored in plaintext). The connector gives chats no names of their own.

Logging at the default level (info) carries no message content or contact names. The chat
log's raw events and read-receipt responses are logged only at trace level.

## Known limits

The connector is minimal:

- **Text only, both ways.** Incoming embeds (a shared post, an image) arrive as their text
  only, which can be empty; a media send from the app is refused (`unsupported`).
- **No reactions, edits or deletions** are bridged either way (Bluesky has no edits; its
  reactions and deletions are ignored). Read receipts from the app are sent to Bluesky.
- **Backfill** is the newest messages of the 20 most recent conversations, fetched when the
  account connects; older history isn't fetched (the connector has no backward backfill, so
  bridgev2's backfill queue logs an error for those chats and moves on).
- New messages arrive by **polling every 5 seconds**, not push.
- The session is refreshed before its access token expires and at every start. If the
  refresh fails at start (the bridge host was down past the refresh token's lifetime, or the
  app password was revoked), the login shows an error and stays down until you connect again.

## How to test

With Isaac's account:

- [ ] **Connect**: an app password with direct messages allowed, server left as
      `bsky.social`; the login completes. (Optional: an app password without the DM box
      ticked connects but never syncs chats, and the login reports it isn't connected.)
- [ ] **Receive**: a DM from another account arrives within a few seconds, with the sender's
      name.
- [ ] **Send**: a text message from the app arrives in Bluesky; its status reaches `sent`.
- [ ] **Reply / edit / react**: not supported; check the app doesn't offer them or that they
      fail cleanly.
- [ ] **Media**: an image from the app is refused; an image or shared post sent to you arrives
      as its text.
- [ ] **Read**: reading a chat in the app marks it read in Bluesky.
- [ ] **Backfill**: recent messages of the newest conversations appear after connecting.
- [ ] **Reconnect after restart**: restart `bridge-bluesky`; messages sent meanwhile arrive.
- [ ] **Log out**: logging out in the app ends the login and deletes the session on Bluesky.

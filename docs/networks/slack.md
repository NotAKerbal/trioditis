# Slack

Slack workspaces, through `go.mau.fi/mautrix-slack` **v0.2611.0** (`SlackConnector`), built
against beeper's slack-go fork (`github.com/beeper/slackgo
v0.0.0-20261109170826-c51406334f5e`, the same `replace` the connector's own `go.mod`
names). Network ID `slack`, maturity **experimental** (a later candidate in docs/PLAN.md),
`termsRisk: true`.

One login is one workspace, as one Slack user. Connect each workspace separately; they
show up as separate accounts.

## How chats map

| Slack                       | bridgev2 room type | Trioditis chat `kind`                     |
| --------------------------- | ------------------ | ----------------------------------------- |
| The workspace               | space              | `space`                                   |
| Public and private channels | default            | `group`, with the workspace as its parent |
| Group DMs (mpim)            | group DM           | `group`, with the workspace as its parent |
| DMs, including the self DM  | DM                 | `dm`, with the workspace as its parent    |

Every channel and DM has the workspace portal as its parent, so `parentPortalId` points
at the workspace's `space` chat.

**Gap: `channel`.** `ChatKind` has `channel`, but the bridge host never produces it: its
`roomKind` maps bridgev2's default room type to `group` for every network. Slack channels
therefore arrive as `group`, the same as group DMs. Telling them apart needs either a
connector hint or a host rule (for example, "a default-type room with a space parent is a
channel"); that's a host-wide decision, so it isn't made here.

**Threads.** Slack threads come through: a message in a thread carries `threadRoot`
(bridgev2 thread relation), and thread replies are backfilled with their root. Sending
into a thread works without a `threadRoot` on the send command: Slack has no replies, only
threads, so bridgev2 turns a reply (`replyTo`) into a thread reply to that message (or to
its thread, if it's already in one).

## Logging in

The connector's three flows, in the order the app lists them:

| Flow ID | Stepper kind | First step                                               | Needs Slack's servers |
| ------- | ------------ | -------------------------------------------------------- | --------------------- |
| `token` | `cookies`    | `auth_token` (xoxc-) and `cookie_token` (the `d` cookie) | from the submit on    |
| `email` | `form`       | email address, then a code Slack emails                  | from the submit on    |
| `app`   | `form`       | bot token (xoxb-) and app-level token (xapp-)            | from the submit on    |

### Token and cookie (recommended)

1. In a desktop browser (a private window is fine), open `https://app.slack.com/client`
   and sign in to the workspace. Use the browser, not the Slack desktop app.
2. Open developer tools, **Console**, and run
   `Object.values(JSON.parse(localStorage.localConfig_v2).teams).map(t => [t.name, t.token])`.
   Copy the `xoxc-…` token of the workspace you want. (It is in local storage, not a
   cookie, whatever the stepper's line says.)
3. Developer tools, **Application** (Chrome) or **Storage** (Firefox), **Cookies**,
   `https://app.slack.com`: copy the value of the cookie named `d` (domain `.slack.com`,
   starts `xoxd-`). Either form is fine: as shown (percent-encoded, `%2F`…) or decoded.
4. In Trioditis: Settings, Accounts, Slack, **Token and cookie**. Paste the xoxc token
   into `auth_token` and the xoxd cookie into `cookie_token`. Ignore the instruction about
   a JSON object or a cURL command: that's for Matrix bot commands; here each value has
   its own field.
5. Close the browser window **without signing out**. Signing out of that browser session
   ends the bridge's session too, because they are the same session.

Logging out in Trioditis signs that Slack session out (`auth.signout`).

### Email code

Enter the address, then the six-character code Slack emails. It then signs in to the
workspace on its own if the account is in one workspace that allows email sign-in, and
asks for a six-digit 2FA code if the workspace requires one. It can stop short in the app
today:

- **CAPTCHA.** If Slack wants a CAPTCHA first (it decides per request; likely from a
  server's address), the step is a `cookies` step whose only field, `captcha_token`, is
  filled by running a reCAPTCHA in an embedded browser (`extract_js`). The stepper can't
  run it, so this is a dead end: cancel and use the token flow.
- **Several workspaces.** The workspace choice is a `select` field, but the bridge
  protocol's `LoginField` carries no options, so the stepper shows an empty text box. Typing
  the exact label (`Workspace Name (domain.slack.com)`) works; there's no way to see it.
- **SSO or no email sign-in.** The connector asks for the browser token and cookie for
  that workspace instead (the same fields as the token flow, with the workspace's URL), so
  follow the token flow steps.

### Slack app (bot)

For a workspace you administer. Create an app from mautrix-slack's
[`app-manifest.yaml`](https://github.com/mautrix/slack/blob/main/app-manifest.yaml)
(Socket Mode on), install it, and enter the bot token (`xoxb-…`) and an app-level token
(`xapp-…`, scope `connections:write`). It bridges only what the bot can see and sends as
the bot, so it is not a way to read your own DMs.

### What the bridge host and stepper do with these steps

- `cookies` steps reach the app with only `url`, `userAgent` and each field's `id` and
  `required`. The field sources (`special` `fi.mau.slack.auth_token`, the request-body
  `token`, the `d` cookie), patterns and `extract_js` are not carried, so the person
  copies values by hand. For the token flow that's enough (this page says where to look).
- The bridge host percent-decodes values for fields whose source is a browser cookie
  before handing them to the connector, as bridgev2's own cookie login does. Without it,
  a `d` cookie copied as developer tools show it failed: slack-go percent-encodes the
  cookie again.
- The bridge host no longer passes on a connector's text for the `complete` step. Slack's
  is "Successfully logged into <workspace> as <email>", which would otherwise sit in
  plaintext in the backend's login session and the journal; the app shows its own text.
- Still plaintext in a login step: the email flow's instructions name a workspace when
  sign-in to it fails or it needs SSO ("<workspace> uses single sign-on…"), and they reach
  the backend's login session like any step.

Generic fixes that would close the email flow's gaps (and help Meta, LinkedIn and X):
carry a field's `options` for `select` fields, and a cookie step's `extractJs` and field
sources, through the protocol, with the stepper rendering them.

## Operator settings

None. The connector needs no API keys, and the bridge host sets what it changes in code
(`apps/bridge-host/internal/networks/slack.go`):

- **`custom_emoji_reactions: false`.** With it on, a custom emoji reaction's key is the
  `mxc://` URI of the emoji image. The bridge host keeps an upload only until a sealed
  event uses it (10 minutes at most), and a reaction key isn't sealed, so it would be a
  dead link. Off, the key is the shortcode (`:party-parrot:`).
- **`slackdb.PostgresArrayWrapper = pq.Array`.** mautrix-slack's own `main` sets this; the
  bridge host has to as well. Without it, pruning custom emoji that a workspace deleted
  calls a nil function on PostgreSQL (as deployed) and the process crashes.

Everything else is the connector's example config: display names
`{{or .Profile.DisplayName .Profile.RealName .Name}}`, channel names `#name` for public
channels, the workspace's name for the space, `participant_sync_count: 5`,
`backfill.conversation_count: -1` (every chat in Slack's `client.boot` response),
`dm_only: false`. The connector also turns off bridgev2's personal filtering spaces.

Media: the connector downloads files up to 50 MiB (its default; the bridge host never
calls `SetMaxFileSize`). Slack voice clips are converted to Ogg/Opus only if `ffmpeg` is
on the bridge host's `PATH`; otherwise they arrive as the file Slack stores.

## What's stored in plaintext

Beyond bridgev2's own tables (chat names and topics in `portal`, names in `ghost`, see
docs/architecture/sealing.md):

- **No message content.** The connector keeps no message bodies: its `message` metadata
  is `caption_merged` and `last_edit_ts`; nothing it writes to disk holds text.
- **`emoji` table** (`team_id`, `emoji_id`, `value`, `alias`, `image_mxc`): the
  workspace's custom emoji, their shortcodes (chosen by the workspace, so they can be
  names, like `:alice-wave:`), Slack CDN URLs and aliases. `image_mxc` points at an upload
  that the bridge host has already dropped, so it's useless but harmless. Not bounded:
  it mirrors the workspace's emoji list and the connector prunes deleted ones itself.
- **`user_login`**: the remote name (`<workspace> - <email>`), and in the metadata the
  email, the xoxc token and `d` cookie (or bot and app tokens). These are live
  credentials for the Slack session. Logout clears them.
- **`portal` metadata** for the workspace: its subdomain, edit window and whether
  deletes are allowed. **`ghost` metadata**: timestamps only.
- **Files and caches.** None on disk. Channel info, users and last-read markers are
  cached in memory. Media passes through the bridge host's memory-backed temp files like
  every network's.
- **Logs.** No message content at info level. Channel info (names) is logged only at
  trace level, and slack-go's request debugging only at trace; the bridge host runs at
  info, or debug with `--verbose`. slack-go's own messages go to debug.

Nothing needs a sweep like WhatsApp's buffer.

## Known limits and terms risk

- **Terms.** The token and email flows run your own browser session from a server, an
  unofficial client using a session token. Slack's acceptable use policy forbids
  accessing the services other than through its supported interfaces, and many
  workspaces (employers especially) forbid it too; an admin can see the session under
  your account's sessions, and some workspaces revoke unknown sessions or alert on them.
  Slack isn't known for banning accounts over it, but the workspace owner decides, so
  `termsRisk` is true. The app flow is an official API, within that workspace's approval.
- Inline custom emoji in a message are rendered as `<img data-mx-emoticon src="mxc://…">`
  in its HTML, pointing at an upload the bridge host has dropped, with the shortcode as
  `alt`. How the app shows them depends on its HTML handling.
- Edits are refused after the workspace's edit window; deletes when the workspace forbids
  them.
- One login per workspace. Enterprise Grid is untested.

## How to test

Use a workspace you can afford to experiment in. Run the bridge host for `slack` (compose
profile `slack`, or `bridge-host --network slack --dev-keys --user <id> login` locally),
and connect with the token flow.

- [ ] **Connect**: token flow, both fields pasted (try the `d` cookie as developer tools
      show it, percent-encoded). The stepper says Slack is connected; the workspace
      appears as a space, its channels and DMs under it.
- [ ] **Receive**: a message in a channel, a DM and a group DM.
- [ ] **Send**: from Trioditis to each of those; it appears in Slack as you.
- [ ] **Reply**: reply to a message in Trioditis; in Slack it's a thread reply. A
      message posted in a Slack thread arrives with its thread root.
- [ ] **Edit**: both directions; also one past the workspace's edit window, if it has
      one (refused).
- [ ] **React**: a Unicode emoji both ways, and a custom emoji from Slack (arrives as its
      `:shortcode:`).
- [ ] **Media**: an image and a file both ways; a voice clip from Slack.
- [ ] **Backfill**: older history in a channel and a thread loads.
- [ ] **Reconnect after restart**: restart the bridge host; messages sent meanwhile
      arrive, and sending still works.
- [ ] **Log out**: from Trioditis. The Slack session is signed out (check the browser
      session you copied from), and nothing more arrives.
- [ ] **Email flow** (optional): note whether Slack asks for a CAPTCHA, and what the
      workspace step shows with more than one workspace.

# Telegram

Telegram through mautrix-telegram's Go rewrite on bridgev2: the bridge host logs in as the
person, the way Telegram Desktop does, and bridges their private chats, groups,
supergroups, channels and forum topics. Maturity: **beta** (docs/PLAN.md, Networks).

|                  |                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Network ID       | `telegram`                                                                                                      |
| Connector        | `go.mau.fi/mautrix-telegram` v0.2611.0, `pkg/connector` (`TelegramConnector`), MTProto through its fork of gotd |
| Bridge host file | `apps/bridge-host/internal/networks/telegram.go`                                                                |
| Compose service  | `bridge-telegram` (profile `telegram`, database `bridge_telegram`)                                              |
| Login flows      | `qr` (scan a QR code), `phone` (phone number, code, then 2FA password if set)                                   |
| Terms risk       | No: Telegram lets anyone build a client on its API with their own API ID                                        |

## Operator settings

Telegram only lets a client in with an **API ID and hash** that it issues to whoever runs
the client. The connector's example config has placeholders, which Telegram refuses, so the
operator supplies their own. Nobody else's will do, and Trioditis ships none.

1. Sign in at <https://my.telegram.org> with the phone number of any Telegram account (the
   operator's own is fine; it doesn't have to be one that will be bridged).
2. Open **API development tools** and create an application. Title and short name can be
   anything (say, "Trioditis" and "trioditis"); platform "Desktop"; the URL can be left
   empty.
3. Copy **App api_id** (a number) and **App api_hash** (32 hex digits).

Then pass them to the installer, which keeps them in `deploy/.env` (and in backups'
`secrets.env`) for later reruns:

```sh
deploy/install/install.sh --networks whatsapp,telegram --telegram-api-id <api_id> --telegram-api-hash <api_hash>
```

The installer stops if Telegram is in `--networks` without both, or with values that can't be
right. The bridge host checks them too: without `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`
in its environment it refuses to start, saying what to set. Outside Compose (`pnpm dev
--network telegram`, or `bridge-host --network telegram`), export the two variables first.

One app serves everyone on the server. Telegram can limit or revoke an app that is used
abusively, which would stop every login on it; the app's hash is a credential, so treat it
like one (it ends up in shell history when passed as an option).

What Trioditis changes from the connector's defaults, in `telegram.go`:

- The device model shown in the person's Telegram **Devices** list is "Trioditis".
- The Saved Messages chat has no avatar: the default points at an image on maunium.net's
  homeserver, and there's no homeserver here to fetch it from.
- The connector's file cache is kept short (see below).
- The compose service sets `TMPDIR=/dev/shm`, so the few files the connector converts
  through a temporary file stay in memory.

Everything else is the connector's example config: on login the 15 most recently active
chats are created (`sync.create_limit`; others appear when a message arrives), up to 100
members are synced per chat, communities become spaces, and data-export ("takeout") mode is
off.

## Connecting an account

In Settings, add Telegram, and pick either flow.

**Scan a QR code** (`qr`). On the phone, open Telegram → Settings → Devices → **Link
Desktop Device**, and scan the code Trioditis shows. The code renews itself every 30
seconds or so; the stepper shows each new one. If the account has a cloud password
(two-step verification), Trioditis then asks for it.

**Phone number** (`phone`). Enter the number in international form (`+1 555…`). Telegram
sends a login code, normally to the Telegram app on another device (otherwise by SMS, a call,
or email; the step says which). Enter it, then the cloud password if the account has one.
A wrong code or password asks again. Telegram refuses this flow for accounts it wants to set
up a login email first ("please log in with a QR code instead"), and Trioditis can't create
new Telegram accounts.

The connector also has `bot` (log in as a bot with a BotFather token) and `manual` (paste
raw session credentials; the connector itself says not to use it). Trioditis doesn't offer
either: a bot account isn't a person's messages, and the manual flow is for debugging.

The login appears in Telegram's **Devices** list as "Trioditis", and can be ended from
there like any other session.

## What's stored in plaintext

Message text, captions and media are never stored by this connector: incoming messages are
sealed and journaled by the bridge host, outgoing ones arrive sealed, and attachments only
pass through memory (docs/architecture/sealing.md). What it does keep, in the bridge host's
database (`bridge_telegram`):

- **bridgev2's own tables**, as for every network: chat names and topics (`portal`),
  contact names, usernames and phone numbers (`ghost`), and the person's own name and phone
  number (`user_login`).
- **The session**, in `user_login.metadata`: the MTProto auth key, data centre and the phone
  number used to log in. The auth key is the whole login: whoever holds it can read and send
  as the person until the session is ended. Logging out clears it.
- **`telegram_phone_number`**: the phone number of every Telegram user the connector has
  seen one for (contacts, and others who show their number), with their user ID. Shared by
  all logins and not cleared on logout.
- **`telegram_username`**: public @usernames of users and channels the connector has seen,
  with their IDs. Shared and not cleared on logout either.
- **`telegram_access_hash`, `telegram_user_state`, `telegram_channel_state`,
  `telegram_topic`**: IDs, access hashes and update sequence numbers. No content. A login's
  rows go when it logs out.
- **Content hashes**, in `message.metadata` (`content_hash`): an unsalted SHA-256 of each
  bridged message's text (its HTML when formatted), link preview URL and media ID. It isn't
  the text, but a short or predictable message ("ok", "see you at 8") can be found by trying
  candidates, so treat it as close to plaintext. The connector uses it to ignore edit
  updates that change nothing, which Telegram sends, for example, when a link preview
  loads; without it each would show as an edit. It is kept as long as the
  message row. The connector also logs it, base64, at info level each time a message is sent
  from Trioditis (`sent message successfully`). **Not bounded**; candidates are a sweep that
  clears it after some days (old messages would then show spurious edits) or sealing the
  column in Phase 1.
- **`telegram_file`**: which content URI each Telegram file (photos, documents, stickers,
  avatars, custom emoji) was uploaded to, with its type, size and dimensions. No content,
  but the connector reuses an entry instead of downloading the file again, and the bridge
  host's uploads only live in memory for 10 minutes (`media.UploadTTL`), so an old entry
  would make a message arrive without its file. The bridge host clears the table when
  Telegram starts and, every minute, deletes entries older than 5 minutes.

Nothing is written to the data directory beyond the database. Temporary files: outgoing
stickers and WebP images are converted through `os.TempDir()`, which the compose service
points at `/dev/shm`; run elsewhere without `TMPDIR` set, they briefly land in `/tmp`.
Incoming sticker conversions happen next to the bridge host's own memory-backed file.

Logs: no message content or names at info level, apart from the content hash above. The
chat-list and history requests it logs at info level hold peer IDs and offsets. With
`--verbose`, it also logs the login phone number when re-logging in.

## Known limits

- **Animated stickers** (Telegram's Lottie `.tgs` format) arrive as
  `application/x-tgsticker` files that clients can't show: converting them needs
  `lottieconverter`, which the bridge host image doesn't include. Video stickers (WebM) and
  static stickers come through as they are. Sending a sticker that isn't PNG, JPEG, WebM or
  `.tgs` needs `ffmpeg`, also not in the image.
- **Secret chats and calls** aren't bridged; the connector doesn't support them. They stay
  on the phone.
- The QR flow's first step needs Telegram to accept the app's credentials, so it was only
  checked up to the connection: with made-up credentials the bridge host reaches Telegram
  and waits at session set-up. If a QR code never appears with real ones, check the API ID
  and hash first.
- Only one person per server should use any single Telegram account; a second Trioditis
  login of the same account replaces the first (`DeleteOnConflict`).

## How to test

With the operator settings in place and Telegram enabled:

- [ ] **Connect** with `qr` (and once with `phone`, including the code and, if set, the
      cloud password). "Trioditis" appears under Telegram → Settings → Devices.
- [ ] **Receive**: a message from a contact, in a group and in a channel arrives in the
      right chat, with the right sender and name.
- [ ] **Send** a text from Trioditis to a private chat and to a group; it shows on the
      phone once.
- [ ] **Reply** both ways; the reply points at the right message.
- [ ] **Edit** both ways; the edit replaces the text. A link preview loading on the phone
      doesn't show as an edit.
- [ ] **React** both ways, with a standard emoji (and note what a custom emoji does).
- [ ] **Media**: a photo, a video, a voice message, a document, a static and a video sticker
      arrive and open; a photo and a file sent from Trioditis arrive on the phone. Send the
      same sticker twice, more than 10 minutes apart: both arrive with the image.
- [ ] **Backfill**: older history fills in for recently active chats; a chat outside the
      first 15 appears when it gets a message.
- [ ] **Reconnect after restart**: restart `bridge-telegram`; messages sent while it was down
      arrive, and the login stays connected without logging in again.
- [ ] **Log out** from Trioditis: the session disappears from Telegram's Devices list. Ending
      the session from the phone instead shows the login as logged out in Trioditis.

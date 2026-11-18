# Client API

What the desktop and web client (`apps/desktop`) calls, and how it opens what it gets
back. The functions are Convex functions in `packages/backend/convex`, imported as `api`
from `@trioditis/backend/api`; shared types come from `@trioditis/core`, and sealing from
`@trioditis/crypto`.

Every function needs a signed-in member of the server unless it says otherwise, and
refuses anyone else's data with the same error as a missing row. Errors are `ConvexError`s
whose `data` is a sentence the UI can show as it is. Any of those functions can also throw
`You’re signed out. Sign in again to continue.` and `Your account isn’t a member of this
server.`; each section lists the rest, word for word.

Nothing readable ever goes to the server: names, message bodies, label names and drafts are
sealed on the device (`docs/architecture/sealing.md`) and opened on the device. Not even
the password reaches the server (see Passwords).

## Setup on the client

The app gets three settings at build time: `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and
`VITE_TRIODITIS_ENVIRONMENT`. The self-hosted bundle doesn't build per server, so when they
aren't set the app reads `/config.json` instead:

```json
{ "convexUrl": "…", "convexSiteUrl": "…", "environment": "…" }
```

**Auth is same-origin.** The app reaches Better Auth at `/api/auth/*` **on its own
origin**: in the self-hosted bundle Caddy proxies that path to the Convex site, and in
development the Vite dev server does. Cookies and passkeys then belong to the app's origin,
and no cross-origin auth is configured or supported.

```ts
import { ConvexReactClient } from 'convex/react'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { createAuthClient } from 'better-auth/react'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'

const convex = new ConvexReactClient(config.convexUrl)
const convexQueryClient = new ConvexQueryClient(convex)
// No baseURL: Better Auth uses the app's own origin, /api/auth.
export const authClient = createAuthClient({ plugins: [convexClient(), passkeyClient()] })
```

Wrap the app in `ConvexBetterAuthProvider` (from `@convex-dev/better-auth/react`) with
`client={convex}` and `authClient={authClient}`, and query with
`useQuery(convexQuery(api.chats.counts, {}))`. Call `ready()` from `@trioditis/crypto`
once before any sealing or password derivation.

### Server settings that matter to the client

| Convex env                             | Must be                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`                             | Exactly the origin the browser uses for the app, and so for auth. Better Auth refuses other origins and passkeys register to it                                                                                           |
| (static JWKS)                          | Not supported yet: Convex refuses to deploy an auth config that reads an unset variable. A server that can't reach its own public address routes it to itself instead, as the self-hosted bundle does (Phase 1 follow-up) |
| `TRIODITIS_DEMO`, `TRIODITIS_NETWORKS` | `1` and `fake` on preview and nightly deployments, for `demo.seedForMe`. `TRIODITIS_DEMO=1` alone turns invitations off                                                                                                   |

## Passwords

A password does two jobs, and the server sees neither as the password:

- **Signing in.** The app sends `authPassword(password, email)` (from `@trioditis/crypto`)
  to Better Auth, never the password. It is Argon2id over the password (NFKC-normalised),
  salted by the lowercased email, then BLAKE2b-256, as base64url.
- **Unlocking the key.** The key backup is wrapped by `passwordKey(password, params)`: a
  separate Argon2id with its own random salt and stronger settings.

The server can't unwrap a key backup without guessing the password, and each guess against
the backup costs an Argon2id run (64 MiB, three passes). But the server also keeps Better
Auth's hash of the sign-in credential, so someone holding the database can test a guess more
cheaply that way: `authPassword`'s Argon2id is libsodium's interactive setting (64 MiB, two
passes), then Better Auth's scrypt. A guess that matches the sign-in credential also unlocks
the key. A short password is the weak point: ask for a long one.

Because the email salts `authPassword`, changing the email means re-deriving it (a
follow-up: there is no email change yet).

## Accounts

A server has no open sign-up. Every account starts from an invitation, and the first one,
the admin, from the setup token the installer prints (`TRIODITIS_SETUP_TOKEN`).

| What                | How                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First admin         | `authClient.signUp.email({ email, password: authPassword(pw, email), name }, { headers: { 'x-trioditis-invite': setupToken } })`. Works once, while the server has no members |
| Invited sign-up     | The same, with the invitation's token from its link in `x-trioditis-invite`. The email must be the invited one                                                                |
| Sign in             | `authClient.signIn.email({ email, password: authPassword(pw, email) })`, or `authClient.signIn.passkey()`                                                                     |
| Add a passkey       | `authClient.passkey.addPasskey()` while signed in                                                                                                                             |
| Change the password | `api.account.changePassword` (see Keys, Changing the password). Better Auth's own `changePassword`, password reset and `changeEmail` are turned off and answer 404            |
| Sign out            | `authClient.signOut()`                                                                                                                                                        |
| Who am I            | `api.members.me` returns `{ userId, role, identityKid }`, or `null` when signed out or not a member                                                                           |
| Invite (admin)      | `api.members.invite({ email, role })` returns `{ invitationId, token }`. The token is returned once: build the link from it                                                   |
| Invitations (admin) | `api.members.invitations` lists the server's invitations, without tokens. `api.members.revokeInvitation({ invitationId })`                                                    |

Sign-up without a valid token fails with Better Auth's `FORBIDDEN` and code
`INVITE_REQUIRED`.

Errors: `Only an admin can do that.` (`invite`, `invitations`, `revokeInvitation`) ·
`Invitations are turned off on demo servers.` · `That isn’t an email address.` · `That
invitation can’t be revoked.` · `Someone is signing up with that invitation right now. Try
again in a few minutes.`

## Keys

The person's **identity key pair** is what everything is sealed to. The private key exists
only on their devices. So a new device can get it, the server keeps it **wrapped**: by the
password, by the **recovery key**, and later by a passkey. The server can't unwrap any of
them.

`api.keys.identity` returns `{ state, publicKey, kid, backups }`. What to do for each
`state`:

| `state`       | Means                                                | The UI                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`        | No identity key yet                                  | First-device setup, below                                                                                                                                                                                               |
| `needsBackup` | A key, but not both a password and a recovery backup | On a device that has the key: make the missing backups and call `keys.setup` with a proof. On a device that doesn't: say "finish setup on the device you first used". Connecting networks is blocked until this is done |
| `ready`       | Key and both backups                                 | On a new device, unlock with the password or the recovery key                                                                                                                                                           |

### First device

```ts
const identity = generateKeyPair()
// The password and recovery-key backups. It opens both again before returning, and throws
// unless both give back this key: the server can't check them.
const { args, recoveryText } = makeKeySetup(identity.privateKey, pw, userId) // show recoveryText once
// Prove the device holds the key: the challenge is sealed to the key being set up.
const { sealed } = await convex.mutation(api.keys.challenge, { publicKey: args.publicKey })
const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
await convex.mutation(api.keys.setup, { ...args, proof })
```

- `makeKeySetup` runs `passwordKey`, which takes about a second; show progress. Building
  the wraps by hand (`wrapIdentityKey`) works too, but then open each with
  `unwrapIdentityKey` before calling `keys.setup`, as `makeKeySetup` does.
- Keep the unwrapped key on the device (IndexedDB, non-extractable where possible) until
  sign-out.
- The person must confirm they saved the recovery key before going on: without it, a
  forgotten password loses their history.
- `keys.setup` always needs `proof`. Before the account has a key, get it from
  `keys.challenge({ publicKey })` naming the key being set up; the proof then works only
  for that key. The server refuses a public key nothing can be sealed to (not 32 canonical
  bytes, or a low-order X25519 point), in `keys.challenge` and in `keys.setup`.
- `keys.setup` is complete only when both backups exist. Repeating it with the same key then
  does nothing; a different key for an account that has one is refused.
- For a key that exists without its backups (`needsBackup`), get the proof from
  `keys.challenge({})` (below).

**What changed for the desktop app:** `keys.setup`'s `proof` is now required on the first
device too, so call `keys.challenge({ publicKey })` first; `keys.challenge` gained the
optional `publicKey` argument; and `makeKeySetup` (and `makeKeyBackup`) now check their
wraps and throw a `SealError` if one doesn't open to the key.

### Proving the device has the key

Setting up the key and changing any backup need proof that the device holds the private key,
so the first key is one a device can really use, and a stolen session can't replace
someone's backups and lock them out:

```ts
const { sealed, expiresAt } = await convex.mutation(api.keys.challenge, {})
const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
```

`keys.challenge({ publicKey? })` returns `{ sealed, expiresAt }`. Once the account has a
key it is sealed to that key (`publicKey`, if given, must be it). A proof works once, before
`expiresAt` (five minutes), and only for the key it was sealed to.

### A new device

From `api.keys.identity`, ask for the password and open the `password` backup:

```ts
const backup = backups.find((b) => b.kind === 'password')!
const pair = unwrapIdentityKey(
  backup,
  passwordKey(pw, backup.params!),
  { userId, kid, kind: 'password' },
  fromBase64Url(publicKey),
)
```

A wrong password throws `SealError`. "Use your recovery key instead" does the same with the
`recovery` backup and `decodeRecoveryKey(text)` as the wrapping key; `decodeRecoveryKey`
forgives case, spaces, dashes and look-alike letters, and its checksum catches typos.

### A new recovery key, or a passkey

Wrap again and call `api.keys.putBackup({ kind: 'recovery' | 'passkey', nonce, ct,
credentialId?, prfSalt?, proof, expectedRevision })`. It replaces that backup and returns
its new `revision`. `expectedRevision` is the `revision` of the backup being replaced, as
`keys.identity` showed it (0 for a new passkey). If another device changed it meanwhile, the
call is refused: reload and try again. `api.keys.removePasskeyBackup({ credentialId,
proof })` removes a passkey backup. Password and recovery backups are replaced, never
removed.

Revisions only go up and are never reused, across all of the person's backups: a new or
replaced backup takes the next one, which needn't be the old revision plus one, and a
passkey backup removed and made again gets a new one, so a device still holding the old
revision is refused. A passkey backup needs `credentialId` (base64url, at most 512
characters) and a 32-byte `prfSalt` (base64url); a person can have at most 10.

### Changing the password

One action changes both the sign-in password and the password backup:

```ts
const newParams = newPasswordParams()
const { revision } = await convex.action(api.account.changePassword, {
  currentAuthPassword: authPassword(oldPw, email),
  newAuthPassword: authPassword(newPw, email),
  newWrap: {
    ...wrapIdentityKey(identity.privateKey, passwordKey(newPw, newParams), { userId, kid, kind: 'password' }),
    params: newParams,
  },
  proof,
  expectedRevision, // the password backup's current revision
})
```

It returns `{ revision }`, the password backup's new revision. It checks (and uses up) the
proof, the revision and the settings (never weaker than the backup being replaced), checks
the current password, and then changes the sign-in credential and the password backup in
one transaction, only if neither changed since. Of two devices changing it at once, one
succeeds and the other is refused. Every error leaves both as they were, so signing in and
unlocking always take the same password. Better Auth's own password change is turned off:
this is the only way.

| Error                                                                                                                                                    | State afterwards                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `That proof…` / `This backup changed on another device…` / `Those password settings…` / `That isn’t a wrapped key.` / `Set up this account’s key first.` | Nothing changed                                                       |
| `Your current password is wrong, or the new one isn’t allowed.`                                                                                          | Nothing changed (the proof is used up: get a new one to retry)        |
| `Your password changed on another device. Reload and try again.`                                                                                         | Nothing changed: another change won. Sign in with the password it set |
| `This account has no password to change.`                                                                                                                | Nothing changed                                                       |

### Errors

`That isn’t a valid public key.` · `That isn’t a wrapped key.` · `Those password settings
aren’t allowed.` (weaker than 3 passes over 64 MiB, or weaker than the backup it replaces) ·
`This account already has an identity key. Unlock it with your password or recovery key.` ·
`Set up this account’s key first.` · `That proof of your key has expired or was already used.
Try again.` (also a proof for a different key) · `This backup changed on another device.
Reload and try again.` · `A passkey backup needs its credential and a 32-byte PRF salt.` ·
`You can have at most 10 passkey backups. Remove one first.`

## Preferences

| Function              | Arguments            | Returns                                                                                              |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `api.preferences.get` | none                 | `{ sidebarLayout: 'simple' \| 'focused' }`. **`simple` is the default** for anyone who hasn't chosen |
| `api.preferences.set` | `{ sidebarLayout? }` | `null`. Changes only what it's given                                                                 |

`DEFAULT_PREFERENCES` and the `Preferences` type are in `@trioditis/core`.

## Chats

### Views

Every chat is in exactly one view, stored on the chat, so each list is an index range.
Strongest first:

| View       | Holds                                         |
| ---------- | --------------------------------------------- |
| `blocked`  | Blocked, whatever else is set                 |
| `requests` | Message requests, even if archived or snoozed |
| `snoozed`  | Snoozed and not yet woken, even if archived   |
| `archived` | Archived                                      |
| `inbox`    | Everything else, including a woken snooze     |

**Waking a snooze unarchives the chat:** when its time comes or someone messages, it comes
back to the inbox with `woke: true`, and stays marked as back until the person reads it or
wakes it.

### The list

`api.chats.list({ view?, network?, labelId?, paginationOpts })` returns a page
`{ page: ChatRow[], isDone, continueCursor }` (use `usePaginatedQuery`; default `inbox`).
The list is the view's pinned chats, most recent first, then the rest, most recent first,
paged as one list: pins that don't fit on the first page carry on to the next, and none is
left out. A page holds at most 50 chats (`numItems` above 50 counts as 50) and reads at most
8 MiB, so it can end early: keep loading with the cursor. A page reloaded with an
`endCursor` range is held to the same bounds, and says so with `pageStatus:
'SplitRequired'` and a `splitCursor` (`usePaginatedQuery` splits it). With `network`, only that
network's chats, in the same order. With `labelId`, the chats with that label in the view,
in the order they were labelled, pinned or not.

A `ChatRow` (type in `@trioditis/core`):

| Field                                        | Meaning                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id`, `portalId`                            | The chat, and its opaque network-side ID (the object ID of `sealedMeta`)                                                                            |
| `network`, `networkAccountId`                | Which network and which of the person's accounts it belongs to (`null` if not known yet)                                                            |
| `kind`                                       | `dm`, `group`, `channel`, `space`                                                                                                                   |
| `sealedMeta`                                 | Name, topic and avatar: open with kind `chat`, object ID `portalId`. `null` until described. Plaintext is `ChatPlaintext`; honour `avatarUnchanged` |
| `unreadCount`, `mentionCount`                | Unread messages, and how many of those mention the person (flagged by the bridge host)                                                              |
| `markedUnread`                               | The person marked it unread                                                                                                                         |
| `pinned`, `archived`, `blocked`, `isRequest` | As named                                                                                                                                            |
| `mutedUntil`                                 | `null`, a time, or `Number.MAX_SAFE_INTEGER` for "until I unmute"                                                                                   |
| `snoozedUntil`, `woke`                       | When the snooze ends, and whether it has                                                                                                            |
| `labelIds`                                   | The person's labels on this chat                                                                                                                    |
| `lastMessageAt`                              | Network time of the latest message                                                                                                                  |

`api.chats.get({ chatId })` returns one row. `api.chats.counts` returns
`{ inbox, requests, woke }`, each `{ count, more }`: unread unmuted inbox chats, message
requests, and woken chats. Each count stops at 99; `more` says there may be more ("99+").

### Actions

All take `{ chatId }` plus what's listed, and return `null`.

| Function              | Extra arguments   | Effect                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats.markRead`      |                   | Clears unread, mentions and `markedUnread`, and ends a woken snooze. The network is told the person read up to the newest message that reached the network and isn't deleted, of the newest it reads (at most 50, and 4 MiB of them); if there's none, only Trioditis changes |
| `chats.markUnread`    |                   | Sets `markedUnread`. Trioditis-side: the network still sees it as read                                                                                                                                                                                                        |
| `chats.setArchived`   | `archived`        |                                                                                                                                                                                                                                                                               |
| `chats.setPinned`     | `pinned`          |                                                                                                                                                                                                                                                                               |
| `chats.setMuted`      | `muted`, `until?` | `until` in the future and within a year (365 days); no `until` mutes until unmuted                                                                                                                                                                                            |
| `chats.snooze`        | `until`           | Within a year (365 days); see Views for waking                                                                                                                                                                                                                                |
| `chats.wake`          |                   | Ends a snooze now                                                                                                                                                                                                                                                             |
| `chats.acceptRequest` |                   | Clears the request flag; the chat then moves to the view its other flags give (see Views: the inbox, unless it is also blocked, snoozed or archived). Trioditis-side for now; a later request flag from the network doesn't undo it                                           |
| `chats.setBlocked`    | `blocked`         | Trioditis-side for now: hidden here, but the network isn't told and messages still arrive                                                                                                                                                                                     |
| `chats.setLabels`     | `labelIds`        | Exactly these labels (the person's own, at most 20)                                                                                                                                                                                                                           |

Errors: `That chat doesn’t exist.` · `Pick a time in the future.` · `Pick a time within a
year.` · `That label doesn’t exist.` (`setLabels`, and `list` with `labelId`) · `A chat can
have at most 20 labels.` (`setLabels`)

## Messages

### Reading

`api.messages.list({ chatId, paginationOpts })` pages a chat's messages **newest first**,
at most 100 and 8 MiB a page (`usePaginatedQuery`). Each message:

| Field                                   | Meaning                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `eventId`                               | The network message's ID, or `pending:<clientMessageId>` until a send is echoed                                         |
| `sortKey`, `networkTs`                  | Order and time (the network's, not arrival)                                                                             |
| `sender`                                | `{ self: true }` or `{ ghostId }`                                                                                       |
| `sealed`, `sealedObjectId`              | The content. Open with kind `message` and object ID **`sealedObjectId`**. Missing once deleted                          |
| `sealedEdit`, `editEventId`, `editedAt` | The latest edit: open `sealedEdit` with kind `message` and object ID **`editEventId`**, and show it instead of `sealed` |
| `redactedAt`                            | Deleted for everyone: show "Message deleted"                                                                            |
| `replyTo`, `threadRoot`                 | Event IDs of the quoted message and thread root                                                                         |
| `historical`                            | Imported history: never notify for it                                                                                   |
| `mentionsMe`                            | The bridge host flagged it as mentioning the person                                                                     |
| `clientMessageId`, `delivery`           | For the person's own sends: see Sending                                                                                 |

```ts
const body = openJson<MessagePlaintext>(message.sealedEdit ?? message.sealed!, identity, {
  kind: 'message',
  ownerUserId: userId,
  objectId: message.sealedEdit ? message.editEventId! : message.sealedObjectId,
})
```

Alongside the page:

- `api.messages.reactions({ chatId, messageIds })`, at most 100 IDs, returns
  `{ [messageId]: [{ key, senderKey }] }`: active reactions only, at most 100 per message
  (a message with more shows its first 100). `senderKey` is `self` or `ghost:<ghostId>`.
  It never reads the messages themselves, and reads at most 8 MiB of reactions, going
  through the IDs in order, so it answers a prefix of `messageIds`:
  - **The first ID is always answered** unless it is a deleted message: one message's
    reactions (at most 100 rows of at most 4 KiB) always fit. So a first ID missing from
    the answer is a deleted message, and the client can move past it.
  - A later ID is missing either because it is a deleted message or because the 8 MiB ran
    out before it. To tell which, ask again starting from that ID: then it's first.
  - A deleted message is missing while its reactions are being removed, and present with
    `[]` once they are. An ID that isn't a message in this person's chat is present with
    `[]`. Either way it has no reactions to show.
- `api.messages.receipts({ chatId })` returns `[{ senderKey, upToEventId, networkTs }]`.
- `api.messages.typing({ chatId })` returns `[{ senderKey, expiresAt }]` for rows still
  live when it ran. Hide a row once `expiresAt` passes: queries don't rerun just because
  time passes.

### Sending

```ts
const clientMessageId = crypto.randomUUID().replaceAll('-', '')
const plaintext: MessagePlaintext = { type: 'text', body }
await convex.mutation(api.messages.send, {
  chatId,
  clientMessageId,
  forBridge: sealJson(plaintext, [bridgeKey], { kind: 'outbound', ownerUserId: userId, objectId: clientMessageId }),
  copy: sealJson(plaintext, [identity], { kind: 'message', ownerUserId: userId, objectId: clientMessageId }),
  replyTo, // optional: the eventId of a bridged message in this chat
})
```

- `bridgeKey` comes from `api.keys.bridge`, which is `null` on a server with no bridge key
  set up yet; then sending and connecting networks aren't available:

  ```ts
  const bridge = await convex.query(api.keys.bridge, {})
  if (!bridge) throw new Error('This server isn’t set up to send yet.')
  const bridgeKey = { publicKey: fromBase64Url(bridge.publicKey) }
  ```

- Each sealed object is at most 64 KiB.
- The same `clientMessageId` again does nothing, so retrying a call that may have failed is
  safe.
- The send appears in `messages.list` at once as the pending copy, and the network's echo
  replaces it in place.

`delivery` on the person's own messages:

| State               | Show                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`, `claimed` | Sending (clock)                                                                                                                                                                                                                                                           |
| `submitted`         | Sending, handed to the network                                                                                                                                                                                                                                            |
| `sent`              | Sent (one tick)                                                                                                                                                                                                                                                           |
| `delivered`         | Delivered (two ticks)                                                                                                                                                                                                                                                     |
| `read`              | Read                                                                                                                                                                                                                                                                      |
| `failed`            | Not sent. Offer **Retry** (a new send with a new `clientMessageId`) or **Delete** (`messages.discardSend`)                                                                                                                                                                |
| `unknown`           | **May not have sent.** Trioditis never resends on its own, because the network may have it. Offer "Send again" (a new `clientMessageId`, which may duplicate) or "Discard" (`messages.discardSend({ clientMessageId })`). A late confirmation can still move it to `sent` |

A send that couldn't go out within 24 hours becomes `failed` (never sent) or `unknown` (it
may have reached the network), at that deadline whether or not a gateway is running. One the
bridge host took but never reported on becomes `unknown` an hour after the deadline.

Errors: `That chat doesn’t exist.` · `That message ID isn’t valid.` (16 to 64 letters,
digits, `-` or `_`) · `That message isn’t sealed, or is too long.` · `That message can’t be
replied to.` · `Only a message that failed or may not have sent can be discarded.` · `This
message reached the network, so it can’t be discarded here.` · `Ask for at most 100
messages’ reactions at once.` (`reactions`)

### Scheduled sends

| Function            | Arguments                                                              | Returns                                                                                                           |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `scheduled.create`  | `chatId`, `clientMessageId`, `forBridge`, `copy`, `sendAt`, `replyTo?` | The scheduled ID, or `null` if that `clientMessageId` was already used                                            |
| `scheduled.list`    | `chatId?`                                                              | `[{ _id, chatId, clientMessageId, sendAt, replyTo, state }]`, soonest first. No content                           |
| `scheduled.copies`  | `scheduledIds` (at most 20)                                            | `[{ _id, copy }]`: the person's copies of those still scheduled, to show what each says; open like a pending copy |
| `scheduled.cancel`  | `scheduledId`                                                          | `null`. Cancels one still scheduled, or dismisses one that failed                                                 |
| `scheduled.sendNow` | `scheduledId`                                                          | `null`                                                                                                            |

Seal it exactly as for `messages.send`. At `sendAt` (within a year: 365 days) it becomes an
ordinary send in its chat, on its network, with its 24-hour deadline starting then. A person
can have at most 500 scheduled at once. Its bridge-sealed copy is stored until then, unlike
an ordinary send's, as `sealing.md` (Bridge key exposure) explains and accepts.

`state` is `scheduled`, or `failed` when its time came and its chat was gone: it was never
sent, and its sealed copies are deleted. A failed one stays listed until `scheduled.cancel`
dismisses it. `scheduled.list` returns at most 500 of each state, so at most 500 failed
ones are shown at once; dismissing some brings the rest into view.

Errors: `That chat doesn’t exist.` · `Pick a time in the future.` · `Pick a time within a
year.` · `You can schedule at most 500 messages.` · the sealing and reply errors of
`messages.send` (`create`) · `Ask for at most 20 at once.` (`copies`) · `That scheduled
message doesn’t exist.` · `That message has already gone out.` · `That message couldn’t be
sent: its chat is gone.` (`sendNow` on a failed one)

## Labels

Seal a label's plaintext, `{ name, color }`, to the person: kind `label`, object ID a
`labelKey` the client picks (16 to 64 letters, digits, `-`, `_`).

| Function        | Arguments            | Returns                                                       |
| --------------- | -------------------- | ------------------------------------------------------------- |
| `labels.list`   | none                 | `[{ _id, labelKey, sealed, createdAt }]`                      |
| `labels.create` | `labelKey`, `sealed` | The label's ID (the same one again for a repeated `labelKey`) |
| `labels.update` | `labelId`, `sealed`  | `null`. Seal with the same `labelKey`                         |
| `labels.remove` | `labelId`            | `null`. Also takes it off every chat                          |

At most 100 labels of up to 4 KiB each. `labels.remove` takes the label off its first 1,000
chats at once and the rest in batches straight after; until then a chat may still list the
removed label's ID in `labelIds`. Show only labels that `labels.list` returns.

Errors: `That label ID isn’t valid.` · `That label isn’t sealed, or is too long.` · `You can
have at most 100 labels.` · `That label doesn’t exist.`

## Networks and connecting accounts

`api.networks.list` returns the networks this server enables:

```ts
{ network, name, maturity: 'stable' | 'beta' | 'experimental',
  flows: [{ id, kind: 'qr' | 'phone' | 'cookies' | 'form', name }], termsRisk }
```

The same table is `NETWORK_INFO` in `@trioditis/core`. Show a warning before connecting a
network with `termsRisk` (cookie or token logins can get an account banned).

### The login stepper

1. `const loginSessionId = await convex.mutation(api.logins.start, { network, flowId? })`.
   It needs `keys.identity` in state `ready`. `flowId` is one of the network's `flows` ids
   from `networks.list`; without it, the bridge host uses the network's default login.
2. Watch `api.logins.session({ loginSessionId })`. It returns
   `{ _id, network, state, step, updatedAt }`, or `null` for a login that doesn't exist or
   isn't the person's. `state` is one of `pending`, `active`, `complete`, `cancelled` or
   `error`. `step` is `null` until the bridge host sends the first step (while `pending`);
   then render it (the `LoginStep` type in `@trioditis/core/bridge-protocol`):
   - `displayAndWait`: with `display.type` `qr`, draw `display.data` as a QR code; with
     `code`, show it big, for typing on the phone; with `emoji`, show it to compare
   - `userInput`: a form from `fields` (`id`, `type`, `name`, `description?`, `pattern?`)
   - `cookies`: ask for the listed cookies from `cookies.url`
   - `complete`: done, the account is connected
   - `error`: show the message for `step.error` (an error code; see bridge-protocol.md,
     Errors) and offer to start again
3. Submit what the person entered, sealed to the bridge key, since it's a credential:

   ```ts
   await convex.mutation(api.logins.submit, {
     loginSessionId,
     stepId: step.stepId,
     sealed: sealJson({ input: { [fieldId]: value } }, [bridgeKey], {
       kind: 'outbound',
       ownerUserId: userId,
       objectId: `${loginSessionId}/${step.stepId}`,
     }),
   })
   ```

4. Cancel with `api.logins.cancel({ loginSessionId })`. It's best effort: a login that
   completes while the cancel is on its way still connects.

Accounts: `api.logins.accounts` returns
`[{ _id, network, state, error, lastHealthyAt, updatedAt, logoutPending, logoutError }]`.
`state` is `CONNECTED`, `CONNECTING`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS` (reconnect
it), `UNKNOWN_ERROR` or `LOGGED_OUT`. `api.logins.logout({ networkAccountId })` disconnects
one: `logoutPending` is true until the bridge host confirms; if it couldn't (rejected, or no
bridge host took it within 10 minutes: `expired`; or one took it but never confirmed, an
hour after that: `timeout`), `logoutPending` goes false and `logoutError` says why. Both
happen on time whether or not a gateway is running.

Errors: `That network isn’t enabled on this server.` · `Finish setting up your key, with
its password and recovery key, before connecting a network.` · `That isn’t a login method
this network offers.` · `That step of the login is over. Start again if it didn’t finish.` ·
`That input isn’t sealed, or is too long.` · `That’s already been sent. Wait for the next
step.` (a second submission for the same step) · `That login doesn’t exist.` · `That
account doesn’t exist.`

### Health

`api.networks.health` returns, for each enabled network,
`{ network, bridgeOnline, accounts: [{ networkAccountId, state, error, lastHealthyAt }], status }`:

| `status`   | Means                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `online`   | The bridge host is up and all the person's accounts on it are connected    |
| `degraded` | Some are connected, some aren't                                            |
| `offline`  | The bridge host is down, or none of the accounts is connected: "1 offline" |
| `none`     | The person hasn't connected this network                                   |

`bridgeOnline` goes false two minutes after the bridge host's last heartbeat. Queries rerun
when data changes, not when time passes, so recheck on focus.

## Demo data

For previews and the nightly. `api.demo.seedForMe` (an action, no arguments) gives the
signed-in person a connected fake-network account with six contacts and eight chats (two
groups, a pinned chat, a message request, a snoozed chat and an archived one) of 20
messages each. The fixtures are made-up text sealed on the server to the person's identity
public key, so they open like anything else. It needs `keys.setup` done first and works only
where `TRIODITIS_DEMO=1` and `TRIODITIS_NETWORKS=fake` (exactly when `server.info` says
`demo: true`). The contacts, and each chat with its messages, are written whole, so a call
that fails partway leaves no half-written chat, and calling again finishes the rest. Once
everything is there, a call does nothing (`{ seeded: false }`). Errors: `Demo data is only
available on demo deployments.` · `Set up your key first (keys.setup), then load the demo.`

- **Previews** create a known test account by script: sign up with
  `authPassword(password, email)` and the setup token, call `keys.challenge({ publicKey })`
  and open it with `keyPairFromPrivateKey(privateKey)`, call `keys.setup` with
  `{ ...makeKeySetup(privateKey, password, userId).args, proof }` (the same password backup
  the browser unlocks, plus a recovery backup; `makeKeyBackup` gives the password backup
  alone), then call `demo.seedForMe`.
- **The nightly** has no test account: its first admin signs up with the setup token, sets up
  their key in the app as on any first device, and calls `demo.seedForMe`.

## Contacts

Contact profiles (name, handle, avatar) are sealed with kind `contact`, object ID
`ghostId`. A query for them comes with the conversation view (see Questions).

## Questions and follow-ups

1. **Done:** mentions and message requests come from the bridge host and are applied at
   ingest, and a new message wakes a snoozed chat. A read receipt from the person's phone
   recounts unread and mentions after it.
2. **Network-side block and accept request.** There's no bridge command for either yet, so
   both are Trioditis-side. A `block` command needs a protocol change.
3. **A contacts query**: planned, see Next.
4. **Drafts** synced across devices are in the plan (a sealed `drafts` table) but not built.
5. **Media**: planned, see Next.
6. **Changing the email** needs re-deriving `authPassword`; there's no email change yet.
7. **Passkey PRF unlock**: the backup storage exists (`putBackup` with `kind: 'passkey'`),
   but the PRF flow in the UI doesn't yet.
8. **Label filter order**: a label view is in labelling order, not recency. Sorting it by
   recency needs a per-label recency index.

## Next: after Phase 0

The UI asked for these. They come in this order, on `api/client-next`, each with its
backend tests; the ones that need the bridge host change the protocol in the same pull
request. Until one lands, the UI keeps the control disabled or shows the fallback named
here.

1. **Server info (built).** `api.server.info` (a query, no sign-in needed) returns
   `{ demo, invitations }`: `demo` is whether demo data loads here (`TRIODITIS_DEMO=1` and
   `TRIODITIS_NETWORKS=fake`, as `demo.seedForMe` needs), and `invitations` whether admins
   can invite people here (false wherever `TRIODITIS_DEMO=1`). The client hides invite controls, and shows demo-only ones, from it instead
   of waiting for a mutation's error. The enabled networks stay in `api.networks.list`.
2. **Contacts for senders.** `api.contacts.get({ network, ghostIds })`, at most 100 IDs,
   returns `{ ghostId, sealedProfile }[]` for those the person has (open with kind
   `contact`, object ID `ghostId`; plaintext is `ContactPlaintext`). The client collects
   the `ghostId`s on a page of messages and asks once per page. A list of a chat's members
   needs a new `members` event from the bridge host, so it comes later. Fallback: the
   sender shows as "Someone".
3. **Last-message preview.** Chat rows gain `sealedPreview`: the newest message's body cut
   to 200 characters plus its sender (`ghostId` or self), sealed with a new kind `preview`
   and object ID `portalId`, at most 2 KiB. The bridge host seals it with each `message`
   event; the person's own sends seal one alongside `copy`. Deleting or editing the newest
   message replaces it. It stays small so a page of 50 rows stays well inside the read
   limit. Fallback: no preview line.
4. **New chat.** Two bridge commands, `resolveIdentifier` (a phone number, username or
   email, sealed to the bridge key) and `startChat`, following bridgev2's
   `IdentifierResolvingNetworkAPI` and `CreateChatWithGhost`. The client calls
   `api.chats.start({ networkAccountId, sealedIdentifier })` and watches the returned
   `commandId` until it gives a `chatId` or an error code (`not_found`, `unsupported`).
   Networks that can't resolve identifiers report `unsupported`, and the button stays
   disabled for them (`api.networks.list` gains `canStartChats`). Fallback: "New message"
   disabled.
5. **Media.** Files go through Convex file storage as ciphertext only (the key and nonce
   stay in the sealed message, see `sealing.md`, Media):
   - **Download:** `api.media.url({ chatId, mediaId })` returns a short-lived URL for the
     encrypted file, which the client decrypts. The bridge host uploads incoming files
     encrypted through the gateway (`POST /v1/media`), before the `message` event that
     names them.
   - **Upload:** `api.media.uploadUrl({ chatId, size, mime })` (at most 100 MiB) gives a
     URL for the encrypted file; the send's attachment names the returned `mediaId`, and
     the bridge host fetches it through the gateway and decrypts it with the key in the
     outbound plaintext. Unsent uploads are deleted after a day.
   - Fallback: an attachment shows as a "can't open yet" tile with its name and size.

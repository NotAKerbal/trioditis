# Client API

What the desktop and web client (`apps/desktop`) calls, and how it opens what it gets
back. The functions are Convex functions in `packages/backend/convex`, imported as `api`
from `@trioditis/backend/api`; shared types come from `@trioditis/core`, and sealing from
`@trioditis/crypto`.

Every function needs a signed-in member of the server unless it says otherwise, and
refuses anyone else's data with the same error as a missing row. Errors are `ConvexError`s
whose `data` is a sentence the UI can show as it is.

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
| `TRIODITIS_DEMO`, `TRIODITIS_NETWORKS` | `1` and `fake` on preview and nightly deployments, for `demo.seedForMe`                                                                                                                                                   |

## Passwords

A password does two jobs, and the server sees neither as the password:

- **Signing in.** The app sends `authPassword(password, email)` (from `@trioditis/crypto`)
  to Better Auth, never the password. It is Argon2id over the password (NFKC-normalised),
  salted by the lowercased email, then BLAKE2b-256, as base64url.
- **Unlocking the key.** The key backup is wrapped by `passwordKey(password, params)`: a
  separate Argon2id with its own random salt and stronger settings.

The server can't unwrap a key backup without guessing the password, and each guess costs an
Argon2id run (64 MiB, three passes). A short password is the weak point: ask for a long one.

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
| Sign out            | `authClient.signOut()`                                                                                                                                                        |
| Who am I            | `api.members.me` returns `{ userId, role, identityKid }`, or `null` when signed out or not a member                                                                           |
| Invite (admin)      | `api.members.invite({ email, role })` returns `{ invitationId, token }`. The token is returned once: build the link from it                                                   |
| Invitations (admin) | `api.members.invitations` lists the server's invitations, without tokens. `api.members.revokeInvitation({ invitationId })`                                                    |

Sign-up without a valid token fails with Better Auth's `FORBIDDEN` and code
`INVITE_REQUIRED`.

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
const kid = keyId(identity.publicKey)
const params = newPasswordParams()
const recovery = generateRecoveryKey() // show recovery.text once; the person writes it down
const password = wrapIdentityKey(identity.privateKey, passwordKey(pw, params), { userId, kid, kind: 'password' })
const recoveryWrap = wrapIdentityKey(identity.privateKey, recovery.bytes, { userId, kid, kind: 'recovery' })
await convex.mutation(api.keys.setup, {
  publicKey: toBase64Url(identity.publicKey),
  password: { ...password, params },
  recovery: recoveryWrap,
})
```

- `passwordKey` takes about a second; show progress.
- Keep the unwrapped key on the device (IndexedDB, non-extractable where possible) until
  sign-out.
- The person must confirm they saved the recovery key before going on: without it, a
  forgotten password loses their history.
- `keys.setup` is complete only when both backups exist. Repeating it with the same key then
  does nothing; a different key for an account that has one is refused.
- For a key that exists without its backups (`needsBackup`), pass `proof` as well (below).

### Proving the device has the key

Changing any backup needs proof that the device holds the private key, so a stolen session
can't replace someone's backups and lock them out:

```ts
const { sealed } = await convex.mutation(api.keys.challenge, {})
const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
```

A proof works once, within five minutes.

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

### Changing the password

One action changes both the sign-in password and the password backup:

```ts
const newParams = newPasswordParams()
await convex.action(api.account.changePassword, {
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

It checks the proof, the revision and the settings (never weaker than the backup being
replaced), changes the sign-in password, then stores the new backup. What can go wrong:

| Error                                                                                 | State afterwards                                                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `That proof…` / `This backup changed on another device…` / `Those password settings…` | Nothing changed                                                                                            |
| `Your current password is wrong, or the new one isn’t allowed.`                       | Nothing changed                                                                                            |
| `Your password wasn’t changed. Try again.`                                            | Storing the backup failed, and the sign-in password was changed back                                       |
| `Your password changed, but your key backup didn’t…`                                  | The sign-in password is the new one, but the old password still unlocks the key. Change the password again |

### Errors

`That isn’t a valid public key.` · `That isn’t a wrapped key.` · `Those password settings
aren’t allowed.` (weaker than 3 passes over 64 MiB, or weaker than the backup it replaces) ·
`This account already has an identity key. Unlock it with your password or recovery key.` ·
`Set up this account’s key first.` · `Prove this device has the key first (keys.challenge).`
· `That proof of your key has expired or was already used. Try again.` · `This backup
changed on another device. Reload and try again.`

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
The first page starts with the view's pinned chats (at most 50), then the rest, most recent
first; later pages continue the rest. A page holds at most 50 chats and reads at most 8 MiB,
so it can end early: keep loading with the cursor. With `network`, only that network's
chats. With `labelId`, the chats with that label in the view, in the order they were
labelled, pinned or not.

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

| Function              | Extra arguments   | Effect                                                                                                                                                                                                                                   |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats.markRead`      |                   | Clears unread, mentions and `markedUnread`, and ends a woken snooze. The network is told the person read up to the newest message (of the 50 newest) that reached the network and isn't deleted; if there's none, only Trioditis changes |
| `chats.markUnread`    |                   | Sets `markedUnread`. Trioditis-side: the network still sees it as read                                                                                                                                                                   |
| `chats.setArchived`   | `archived`        |                                                                                                                                                                                                                                          |
| `chats.setPinned`     | `pinned`          |                                                                                                                                                                                                                                          |
| `chats.setMuted`      | `muted`, `until?` | `until` in the future and within a year; no `until` mutes until unmuted                                                                                                                                                                  |
| `chats.snooze`        | `until`           | Within a year; see Views for waking                                                                                                                                                                                                      |
| `chats.wake`          |                   | Ends a snooze now                                                                                                                                                                                                                        |
| `chats.acceptRequest` |                   | Moves a request to the inbox. Trioditis-side for now; a later request flag from the network doesn't undo it                                                                                                                              |
| `chats.setBlocked`    | `blocked`         | Trioditis-side for now: hidden here, but the network isn't told and messages still arrive                                                                                                                                                |
| `chats.setLabels`     | `labelIds`        | Exactly these labels (the person's own, at most 20)                                                                                                                                                                                      |

Errors: `That chat doesn’t exist.` · `Pick a time in the future.` · `Pick a time within a
year.` · `That label doesn’t exist.`

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
  `{ [messageId]: [{ key, senderKey }] }`: active reactions only, at most 100 per message.
  `senderKey` is `self` or `ghost:<ghostId>`. Deleted messages have none.
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

- `bridgeKey` is `{ publicKey: fromBase64Url((await api.keys.bridge).publicKey) }`.
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
may have reached the network).

Errors: `That message ID isn’t valid.` (16 to 64 letters, digits, `-` or `_`) · `That
message isn’t sealed, or is too long.` · `That message can’t be replied to.` · `Only a
message that failed or may not have sent can be discarded.` · `This message reached the
network, so it can’t be discarded here.`

### Scheduled sends

| Function            | Arguments                                                              | Returns                                                                                  |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scheduled.create`  | `chatId`, `clientMessageId`, `forBridge`, `copy`, `sendAt`, `replyTo?` | The scheduled ID, or `null` if that `clientMessageId` was already used                   |
| `scheduled.list`    | `chatId?`                                                              | `[{ _id, chatId, clientMessageId, sendAt, replyTo }]`, soonest first. No content         |
| `scheduled.copies`  | `scheduledIds` (at most 20)                                            | `[{ _id, copy }]`: the person's copies, to show what each says; open like a pending copy |
| `scheduled.cancel`  | `scheduledId`                                                          | `null`                                                                                   |
| `scheduled.sendNow` | `scheduledId`                                                          | `null`                                                                                   |

Seal it exactly as for `messages.send`. At `sendAt` (within a year) it becomes an ordinary
send in its chat, on its network, with its 24-hour deadline starting then. Errors: `Pick a
time in the future.` · `Pick a time within a year.` · `That scheduled message doesn’t
exist.` · `That message has already gone out.`

## Labels

Seal a label's plaintext, `{ name, color }`, to the person: kind `label`, object ID a
`labelKey` the client picks (16 to 64 letters, digits, `-`, `_`).

| Function        | Arguments            | Returns                                                       |
| --------------- | -------------------- | ------------------------------------------------------------- |
| `labels.list`   | none                 | `[{ _id, labelKey, sealed, createdAt }]`                      |
| `labels.create` | `labelKey`, `sealed` | The label's ID (the same one again for a repeated `labelKey`) |
| `labels.update` | `labelId`, `sealed`  | `null`. Seal with the same `labelKey`                         |
| `labels.remove` | `labelId`            | `null`. Also takes it off every chat                          |

At most 100 labels of up to 4 KiB each.

## Networks and connecting accounts

`api.networks.list` returns the networks this server enables:

```ts
{ network, name, maturity: 'stable' | 'beta' | 'experimental',
  flows: [{ id, kind: 'qr' | 'phone' | 'cookies' | 'form', name }], termsRisk }
```

The same table is `NETWORK_INFO` in `@trioditis/core`. Show a warning before connecting a
network with `termsRisk` (cookie or token logins can get an account banned).

### The login stepper

1. `const loginSessionId = await convex.mutation(api.logins.start, { network, flowId })`.
   It needs `keys.identity` in state `ready`.
2. Watch `api.logins.session({ loginSessionId })`. It returns
   `{ _id, network, state, step, updatedAt }`, with `state` one of `pending`, `active`,
   `complete`, `cancelled` or `error`. Render `step` (the `LoginStep` type in
   `@trioditis/core/bridge-protocol`):
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
bridge host took it within 10 minutes), `logoutPending` goes false and `logoutError` says why.

Errors: `That network isn’t enabled on this server.` · `Finish setting up your key, with
its password and recovery key, before connecting a network.` · `That isn’t a login method
this network offers.` · `That step of the login is over. Start again if it didn’t finish.` ·
`That input isn’t sealed, or is too long.` · `That login doesn’t exist.` · `That account
doesn’t exist.`

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
public key, so they open like anything else. It needs `keys.setup` done first, works only
where `TRIODITIS_DEMO=1` and `TRIODITIS_NETWORKS=fake`, and a second call does nothing
(`{ seeded: false }`).

- **Previews** create a known test account by script: sign up with
  `authPassword(password, email)` and the setup token, call `keys.setup` with
  `makeKeySetup(privateKey, password, userId).args` (the same password backup the browser
  unlocks, plus a recovery backup; `makeKeyBackup` gives the password backup alone), then
  call `demo.seedForMe`.
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

1. **Server info.** `api.server.info` (a query, no sign-in needed) returns
   `{ demo, invitations, networks }`: whether this is a demo server, whether an admin can
   invite here, and the networks it has enabled. The client hides demo-only and invite
   controls from it instead of waiting for the mutation's error. Fallback: none needed;
   this lands first.
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

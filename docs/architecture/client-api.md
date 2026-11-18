# Client API

What the desktop and web client (`apps/desktop`) calls, and how it opens what it gets
back. The functions are Convex functions in `packages/backend/convex`, imported as `api`
from `@trioditis/backend/api`; shared types come from `@trioditis/core`, and sealing from
`@trioditis/crypto`.

Every function needs a signed-in member of the server unless it says otherwise, and
refuses anyone else's data with the same error as a missing row. Errors are `ConvexError`s
whose `data` is a sentence the UI can show as it is.

Nothing readable ever goes to the server: names, message bodies, label names and drafts are
sealed on the device (`docs/architecture/sealing.md`) and opened on the device.

## Setup on the client

The app gets three settings at build time: `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and
`VITE_TRIODITIS_ENVIRONMENT`. The self-hosted bundle doesn't build per server, so when they
aren't set the app reads `/config.json` instead:

```json
{ "convexUrl": "…", "convexSiteUrl": "…", "environment": "…" }
```

```ts
import { ConvexReactClient } from 'convex/react'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { createAuthClient } from 'better-auth/react'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'

const convex = new ConvexReactClient(config.convexUrl)
const convexQueryClient = new ConvexQueryClient(convex)
export const authClient = createAuthClient({
  baseURL: config.convexSiteUrl,
  plugins: [convexClient(), passkeyClient()],
})
```

- The Convex client talks to `convexUrl`; Better Auth talks to `convexSiteUrl`, where the
  backend serves `/api/auth/*`.
- In the self-hosted bundle, auth is same-origin: Caddy proxies `/api/auth/*` on the app's
  origin to the Convex site, so `convexSiteUrl` is the app's own origin there.
- The Convex deployment's `SITE_URL` must be exactly the origin the browser uses for auth,
  or Better Auth refuses the requests (trusted origins) and passkeys won't register.

Wrap the app in `ConvexBetterAuthProvider` (from `@convex-dev/better-auth/react`) with
`client={convex}` and `authClient={authClient}`, and query with
`useQuery(convexQuery(api.chats.list, { view: 'inbox' }))`. Call `ready()` from
`@trioditis/crypto` once before any sealing.

## Accounts

A server has no open sign-up. Every account starts from an invitation, and the first one,
the admin, from the setup token the installer prints (`TRIODITIS_SETUP_TOKEN`).

| What                | How                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| First admin         | `authClient.signUp.email({ email, password, name }, { headers: { 'x-trioditis-invite': setupToken } })`. Works once, while the server has no members. |
| Invited sign-up     | The same, with the invitation's token from its link in `x-trioditis-invite`. The email must be the invited one.                                       |
| Sign in             | `authClient.signIn.email({ email, password })`, or `authClient.signIn.passkey()`.                                                                     |
| Add a passkey       | `authClient.passkey.addPasskey()` while signed in.                                                                                                    |
| Sign out            | `authClient.signOut()`.                                                                                                                               |
| Who am I            | `api.members.me` → `{ userId, role, identityKid } \| null`. `null` when signed out or not a member.                                                   |
| Invite (admin)      | `api.members.invite({ email, role })` → `{ invitationId, token }`. The token is returned once: build the link from it.                                |
| Invitations (admin) | `api.members.invitations` → the server's invitations, without tokens. `api.members.revokeInvitation({ invitationId })`.                               |

Sign-up without a valid token fails with Better Auth's `FORBIDDEN` and code
`INVITE_REQUIRED`.

## Keys

The person's **identity key pair** is what everything is sealed to. The private key exists
only on their devices. So a new device can get it, the server keeps it **wrapped**: by a key
derived from the person's password (Argon2id), by their **recovery key**, and later by a
passkey. The server can't unwrap any of them.

### First device

Right after the first sign-in, when `api.keys.identity` returns `publicKey: null`:

```ts
import {
  generateKeyPair,
  keyId,
  newPasswordParams,
  passwordKey,
  generateRecoveryKey,
  wrapIdentityKey,
  toBase64Url,
} from '@trioditis/crypto'

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

- Use the same password the person signs in with, so one password unlocks both. (They are
  separate secrets to the server: Better Auth stores a hash; the key backup is wrapped by
  Argon2id over 64 MiB, three passes.)
- `passwordKey` takes about a second; show progress.
- Keep the unwrapped key on the device (IndexedDB, in a non-extractable form where possible)
  until sign-out.
- The person must confirm they saved the recovery key before you go on: without it, a
  forgotten password loses their history.
- `keys.setup` is all or nothing, and repeating it with the same key does nothing. A
  different key for an account that has one is refused.

### A new device

`api.keys.identity` returns `{ publicKey, kid, backups }`. Ask for the password, find the
`password` backup, and:

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

### Changing the password, or a new recovery key

Unwrap on a device that has the key, wrap again with the new password (new
`newPasswordParams()`) or a new `generateRecoveryKey()`, and
`api.keys.putBackup({ kind, nonce, ct, params? })`. It replaces the backup of that kind.
Change the sign-in password with Better Auth at the same time.

### Passkeys

`putBackup({ kind: 'passkey', nonce, ct, credentialId, prfSalt })` stores a wrap made with a
passkey's PRF output, one per credential; `api.keys.removePasskeyBackup({ credentialId })`
removes it. The PRF flow itself comes with the passkey work in the UI.

### Errors

`That isn’t a valid public key.` · `That isn’t a wrapped key.` · `Those password settings
aren’t allowed.` (weaker than 2 passes over 64 MiB) · `This account already has an identity
key. Unlock it with your password or recovery key.` · `Set up this account’s key first.`

## Preferences

| Function              | Arguments            | Returns                                                                                               |
| --------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `api.preferences.get` | none                 | `{ sidebarLayout: 'simple' \| 'focused' }`. **`simple` is the default** for anyone who hasn't chosen. |
| `api.preferences.set` | `{ sidebarLayout? }` | `null`. Changes only what it's given.                                                                 |

`DEFAULT_PREFERENCES` and the `Preferences` type are in `@trioditis/core`.

## Chats

### The list

`api.chats.list({ view?, network?, labelId? })` returns up to 200 `ChatRow`s (type in
`@trioditis/core`): pinned first, then most recent. Every chat is in exactly one view:

| `view`            | Holds                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| `inbox` (default) | Everything not in another view, including snoozed chats that have woken (`woke: true`) |
| `snoozed`         | Snoozed and not yet woken                                                              |
| `archived`        | Archived                                                                               |
| `requests`        | Message requests (`isRequest`)                                                         |
| `blocked`         | Blocked                                                                                |

A `ChatRow`:

| Field                                        | Meaning                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id`, `portalId`                            | The chat, and its opaque network-side ID (the object ID of `sealedMeta`)                                                                                                         |
| `network`, `networkAccountId`                | Which network and which of the person's accounts it belongs to (`null` if the account row isn't known yet)                                                                       |
| `kind`                                       | `dm`, `group`, `channel`, `space`                                                                                                                                                |
| `sealedMeta`                                 | Name, topic and avatar: open with kind `chat`, object ID `portalId`. `null` until the bridge host has described the chat. Plaintext is `ChatPlaintext`; honour `avatarUnchanged` |
| `unreadCount`, `mentionCount`                | Unread messages, and how many of those mention the person                                                                                                                        |
| `markedUnread`                               | The person marked it unread                                                                                                                                                      |
| `pinned`, `archived`, `blocked`, `isRequest` | As named                                                                                                                                                                         |
| `mutedUntil`                                 | `null`, a time, or `Number.MAX_SAFE_INTEGER` for "until I unmute"                                                                                                                |
| `snoozedUntil`, `woke`                       | When the snooze ends, and whether it has (by time, or because someone messaged)                                                                                                  |
| `labelIds`                                   | The person's labels on this chat                                                                                                                                                 |
| `lastMessageAt`                              | Network time of the latest message, for sorting and "2 min ago"                                                                                                                  |

`api.chats.get({ chatId })` returns one row. `api.chats.counts` returns
`{ inbox, requests, woke }`: unread, unmuted inbox chats, message requests, and woken
chats, for the sidebar badges.

### Actions

All take `{ chatId }` plus what's listed, and return `null`.

| Function              | Extra arguments   | Effect                                                                                                                                          |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats.markRead`      |                   | Clears unread, mentions and `markedUnread`, ends a woken snooze, and tells the network the person read up to the latest message that reached it |
| `chats.markUnread`    |                   | Sets `markedUnread`. Trioditis-side: the network still sees it as read                                                                          |
| `chats.setArchived`   | `archived`        |                                                                                                                                                 |
| `chats.setPinned`     | `pinned`          |                                                                                                                                                 |
| `chats.setMuted`      | `muted`, `until?` | `until` in the future and within a year; no `until` mutes until unmuted                                                                         |
| `chats.snooze`        | `until`           | Hides it until then (within a year); it wakes then, or sooner if someone messages                                                               |
| `chats.wake`          |                   | Ends a snooze now                                                                                                                               |
| `chats.acceptRequest` |                   | Moves a request to the inbox. Trioditis-side for now                                                                                            |
| `chats.setBlocked`    | `blocked`         | Trioditis-side for now: hidden here, but the network isn't told and messages still arrive                                                       |
| `chats.setLabels`     | `labelIds`        | Exactly these labels (the person's own, at most 20)                                                                                             |

Errors: `That chat doesn’t exist.` · `Pick a time in the future.` · `Pick a time within a
year.` · `That label doesn’t exist.`

## Messages

### Reading

`api.messages.list({ chatId, paginationOpts })` pages a chat's messages **newest first**
(use `usePaginatedQuery`). Each message:

| Field                                   | Meaning                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`                               | The network message's ID, or `pending:<clientMessageId>` until a send is echoed                                                                            |
| `sortKey`, `networkTs`                  | Order and time (the network's, not arrival)                                                                                                                |
| `sender`                                | `{ self: true }` or `{ ghostId }`; open the contact's profile from `contacts` (below)                                                                      |
| `sealed`, `sealedObjectId`              | The content. Open with kind `message` and object ID **`sealedObjectId`** (the event ID, or the client message ID for a pending copy). Missing once deleted |
| `sealedEdit`, `editEventId`, `editedAt` | The latest edit: open `sealedEdit` with kind `message` and object ID **`editEventId`**, and show it instead of `sealed`                                    |
| `redactedAt`                            | Deleted for everyone: show "Message deleted"                                                                                                               |
| `replyTo`, `threadRoot`                 | Event IDs of the quoted message and thread root                                                                                                            |
| `historical`                            | Imported history: never notify for it                                                                                                                      |
| `clientMessageId`, `delivery`           | For the person's own sends: see Sending                                                                                                                    |

Opening one:

```ts
const body = openJson<MessagePlaintext>(message.sealedEdit ?? message.sealed!, identity, {
  kind: 'message',
  ownerUserId: userId,
  objectId: message.sealedEdit ? message.editEventId! : message.sealedObjectId,
})
```

Attachments in the plaintext carry their own `key` and `nonce`; files are fetched and
opened with `decryptMedia` (the media path comes with the gateway's media proxy).

Alongside the page:

- `api.messages.reactions({ chatId, messageIds })`, at most 100 IDs, returns
  `{ [messageId]: [{ key, senderKey }] }`. `senderKey` is `self` or `ghost:<ghostId>`.
  Deleted messages have none.
- `api.messages.receipts({ chatId })` returns `[{ senderKey, upToEventId, networkTs }]`, how far each participant has read.
- `api.messages.typing({ chatId })` returns `[{ senderKey, expiresAt }]`. Hide a row once
  `expiresAt` has passed: queries don't rerun just because time passes.

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
- The same `clientMessageId` again does nothing, so retrying a call that may have failed
  is safe.
- The send appears in `messages.list` at once as the pending copy, `eventId`
  `pending:<clientMessageId>`, and is replaced in place by the network's echo.

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

A send that couldn't go out within 24 hours becomes `failed` (never sent) or `unknown`
(it may have reached the network).

Errors: `That message ID isn’t valid.` (16 to 64 letters, digits, `-` or `_`) · `That
message isn’t sealed, or is too long.` · `That message can’t be replied to.` · `Only a
message that failed or may not have sent can be discarded.` · `This message reached the
network, so it can’t be discarded here.`

### Scheduled sends

| Function            | Arguments                                                              | Returns                                                                                                     |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `scheduled.create`  | `chatId`, `clientMessageId`, `forBridge`, `copy`, `sendAt`, `replyTo?` | The scheduled ID, or `null` if that `clientMessageId` was already used                                      |
| `scheduled.list`    | `chatId?`                                                              | `[{ _id, chatId, clientMessageId, sendAt, copy, replyTo }]`, soonest first. Open `copy` like a pending copy |
| `scheduled.cancel`  | `scheduledId`                                                          | `null`                                                                                                      |
| `scheduled.sendNow` | `scheduledId`                                                          | `null`                                                                                                      |

Seal it exactly as for `messages.send`. At `sendAt`, within a year, it becomes an ordinary
send in its chat, on its network, and appears in `messages.list` with its 24-hour deadline
starting then. Errors: `Pick a time in the future.` · `Pick a time within a year.` · `That
scheduled message doesn’t exist.` · `That message has already gone out.`

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

1. `const loginSessionId = await convex.mutation(api.logins.start, { network, flowId })`
   (`flowId` from `flows`). This needs the identity key set up.
2. Watch `api.logins.session({ loginSessionId })`. It returns
   `{ _id, network, state, step, updatedAt }`, with `state` one of `pending`, `active`,
   `complete`, `cancelled` or `error`. Render `step` (the `LoginStep` type in
   `@trioditis/core/bridge-protocol`):
   - `displayAndWait` with `display.type` `qr`: draw `display.data` as a QR code; `code`:
     show it big, for typing on the phone; `emoji`: show it to compare
   - `userInput`: a form from `fields` (`id`, `type`, `name`, `description?`, `pattern?`)
   - `cookies`: ask for the listed cookies from `cookies.url`
   - `complete`: done, the account is connected (`step.loginId`)
   - `error`: show the message for `step.error` (an error code, see bridge-protocol.md,
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

Accounts: `api.logins.accounts` returns `[{ _id, network, state, error, lastHealthyAt,
updatedAt }]`. `state` is `CONNECTED`, `CONNECTING`, `TRANSIENT_DISCONNECT`,
`BAD_CREDENTIALS` (reconnect it), `UNKNOWN_ERROR` or `LOGGED_OUT`.
`api.logins.logout({ networkAccountId })` disconnects one.

Errors: `That network isn’t enabled on this server.` · `Finish setting up this device
before connecting a network.` · `That isn’t a login method this network offers.` · `That
step of the login is over. Start again if it didn’t finish.` · `That input isn’t sealed, or
is too long.` · `That login doesn’t exist.` · `That account doesn’t exist.`

### Health

`api.networks.health` returns, for each enabled network,
`{ network, bridgeOnline, accounts: [{ networkAccountId, state, error, lastHealthyAt }], status }`:

| `status`   | Means                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `online`   | The bridge host is up and all the person's accounts on it are connected    |
| `degraded` | Some are connected, some aren't                                            |
| `offline`  | The bridge host is down, or none of the accounts is connected: "1 offline" |
| `none`     | The person hasn't connected this network                                   |

`bridgeOnline` goes false two minutes after the bridge host's last heartbeat. Queries
rerun when data changes, not when time passes, so an idle stack can look online for a
while after it stops; recheck on focus.

## Contacts

Contact profiles (name, handle, avatar) are sealed with kind `contact`, object ID
`ghostId`. A query for them comes with the conversation view (see Questions).

## Questions

These are things the UI asked for that need a decision or work outside this contract:

1. **Mentions and message requests come from the bridge host.** The backend accepts
   `mentionsMe` on message events and `isRequest` on chat events. Ingesting them
   (`lib/ingest.ts`: count mentions, record requests, and wake a snoozed chat when someone
   messages) is the lead's to add. The bridge host also has to send them. Until then,
   `mentionCount` stays 0, `isRequest` stays false, and a snoozed chat wakes only when its
   time comes.
2. **Network-side block and accept request.** There's no bridge command for either yet, so
   both are Trioditis-side. A `block` command needs a protocol change.
3. **A contacts query** (`contacts.list` / `contacts.get` by `ghostId`) for showing who sent
   a message. Not in this branch; say if the UI needs it now.
4. **Drafts** synced across devices are in the plan (`drafts` table, sealed) but not
   requested for this contract.
5. **Media**: uploading and downloading attachments needs the gateway's media proxy, which
   isn't built yet.

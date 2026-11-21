---
title: Client API
description: Convex queries, mutations, authentication flows, key management, and sealing rules used by Trioditis clients.
---

Trioditis clients (`apps/desktop`) communicate with Convex functions in `packages/backend/convex`, imported as `api` from `@trioditis/backend/api`, using shared types from `@trioditis/core` and cryptographic primitives from `@trioditis/crypto`.

Every function requires an authenticated server member unless noted otherwise and returns the same error for missing and unauthorized rows. Errors are `ConvexError`s whose `data` is either a displayable string or `{ code, message }` (currently `code: 'sessionChanged'`).

## Client initialization

Clients read `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, and `VITE_TRIODITIS_ENVIRONMENT` at build time, falling back to runtime `/config.json` in self-hosted bundles:

```json
{
  "convexUrl": "https://chat.example.com/convex",
  "convexSiteUrl": "https://chat.example.com",
  "environment": "selfhosted"
}
```

```ts
import { ConvexReactClient } from 'convex/react'
import { ConvexQueryClient } from '@convex-dev/react-query'
import { createAuthClient } from 'better-auth/react'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'

const convex = new ConvexReactClient(config.convexUrl)
const convexQueryClient = new ConvexQueryClient(convex)

// No baseURL: Better Auth talks to /api/auth on the app's own origin.
export const authClient = createAuthClient({
  plugins: [convexClient(), passkeyClient()],
})
```

Wrap the app in `ConvexBetterAuthProvider` and call `await ready()` from `@trioditis/crypto` once before any sealing or password derivation.

## Passwords & authentication

A user's raw password never leaves the device:

- **Sign-in credential:** `authPassword(password, email)` (Argon2id over NFKC-normalized password salted by lowercased email, hashed with BLAKE2b-256) is sent to Better Auth.
- **Key backup wrapping:** `passwordKey(password, params)` runs a stronger Argon2id (random salt, ≥ 64 MiB, ≥ 3 passes) to wrap and unwrap the identity private key.

### Account operations

| Action                 | Call                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First admin sign-up    | `authClient.signUp.email({ email, password: authPassword(pw, email), name }, { headers: { 'x-trioditis-invite': setupToken } })`                       |
| Invited sign-up        | Same, passing the invitation token in `x-trioditis-invite` (email must match)                                                                          |
| Sign in                | `authClient.signIn.email({ email, password: authPassword(pw, email) })` or `authClient.signIn.passkey()`                                               |
| Add a passkey          | `authClient.passkey.addPasskey()` with `x-trioditis-session-id` set in `fetchOptions.onRequest`                                                        |
| Change password        | `api.account.changePassword` (atomically rotates sign-in hash and password key wrap; Better Auth's built-in password change/reset routes return `404`) |
| Current identity       | `api.members.me` → `{ userId, sessionId, member }` or `null`                                                                                           |
| End a specific session | `POST /api/auth/end-session` with `{ "token": "<session.token>" }` (safe across multi-tab account switches)                                            |
| Admin invites          | `api.members.invite({ email, role, sessionId? })`, `api.members.invitations`, `api.members.revokeInvitation`                                           |

### Rate limits

Auth routes are rate-limited using persistent Convex token buckets (`rateLimits`):

| Routes                                                           | Limit             | Bucket key                                          |
| ---------------------------------------------------------------- | ----------------- | --------------------------------------------------- |
| `/sign-in/email`, `/sign-up/email`, passkey auth, `/end-session` | 10/min (burst 10) | Client IP (`X-Trioditis-Client-IP`, `/64` for IPv6) |
| All other `/api/auth/*` routes                                   | 300/min           | Client IP                                           |
| `/sign-in/email`, `/sign-up/email`                               | 30/min (burst 30) | Lowercased email (SHA-256 hashed)                   |

Per-IP limits activate whenever Caddy (or a trusted proxy) sets `X-Trioditis-Client-IP`. `account.changePassword` enforces 5 password checks per minute per account.

## Identity keys & backups

`api.keys.identity` returns `{ state, publicKey, kid, backups }`:

| `state`       | Meaning                                               | Client action                                                                                 |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `none`        | No identity key exists yet                            | Run first-device setup                                                                        |
| `needsBackup` | Key exists without both password and recovery backups | Finish backup creation on a device holding the key (network linking is blocked until `ready`) |
| `ready`       | Key and both backups exist                            | Unlock with password or recovery key on new devices                                           |

### First-device setup

```ts
const identity = generateKeyPair()
const { args, recoveryText } = makeKeySetup(identity.privateKey, pw, userId)
// Show recoveryText once and require user confirmation before proceeding.

const { sealed } = await convex.mutation(api.keys.challenge, {
  publicKey: args.publicKey,
  sessionId,
})
const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
await convex.mutation(api.keys.setup, { ...args, proof, sessionId })
```

### Unlocking on a new device

```ts
const backup = backups.find((b) => b.kind === 'password')!
const pair = unwrapIdentityKey(
  backup,
  passwordKey(pw, backup.params!),
  { userId, kid, kind: 'password' },
  fromBase64Url(publicKey),
)
```

For recovery-key unlock, decode the user's text with `decodeRecoveryKey(text)` (tolerant of case, spacing, hyphens, and look-alike characters, with checksum validation) against the `recovery` backup.

### Session-bound writes

Sensitive mutations (`keys.challenge`, `keys.setup`, `keys.putBackup`, `keys.removePasskeyBackup`, `account.changePassword`, `logins.start`, `labels.create`, `demo.seedForMe`, `preferences.set`, `members.invite`, `mcp.authorize`) accept `sessionId` from `members.me`. If another tab switches accounts, the server rejects the call with `{ code: 'sessionChanged', message: 'This page’s session has changed. Reload the page.' }` before writing anything.

Passkey registration binds via the `x-trioditis-session-id` header (`409` on mismatch, without clearing cookies).

## Chats & views

Every chat belongs to exactly one view (ordered highest priority first):

| View       | Contains                                                    |
| ---------- | ----------------------------------------------------------- |
| `blocked`  | Blocked chats                                               |
| `requests` | Unaccepted message requests                                 |
| `snoozed`  | Snoozed chats not yet woken                                 |
| `archived` | Archived chats                                              |
| `inbox`    | Everything else (including woken snoozes with `woke: true`) |

- `api.chats.list({ view?, network?, labelId?, paginationOpts })` pages up to 50 `ChatRow`s (8 MiB limit), pinned first then most recent.
- Each `ChatRow` includes `sealedMeta` (open with kind `chat`, object ID `portalId`), `sealedCollage` (for a group, the members whose contacts' pictures make its picture when it has none: open with kind `chat`, object ID `<portalId>/collage`, plaintext `ChatCollagePlaintext`; `null` until sent) and `lastMessage` (newest message preview up to 4 KiB sealed; open with kind `message`, object ID `lastMessage.objectId`).
- `api.chats.counts` returns `{ inbox, requests, woke }` capped at 99 with a `more` flag.
- Chat actions: `chats.markRead`, `chats.markUnread`, `chats.setArchived`, `chats.setPinned`, `chats.setMuted`, `chats.snooze`, `chats.wake`, `chats.acceptRequest`, `chats.setBlocked`, `chats.setLabels` (up to 20 labels per chat).

## Conversations

A member's direct chats with one person on several networks are shown as one conversation once a People card links the contacts they're with. The server can't put them together, since who a direct chat is with (`dmGhostId` in its sealed metadata) and a card's links are both sealed, so the client does (apps/desktop `data/conversations.ts`):

- **The list.** In each view, a person's direct chats (at most six) come together in the place of the first of them. The row is named and pictured after the card, unread if any chat is, muted only if all are, and shows the newest message of any. A chat stays in its own view.
- **The pane.** Messages of every chat, merged by time, each chat keeping its order. Each chat pages on its own in a slot it keeps as the order changes; only what every chat with more to load has reached is shown, and loading earlier messages loads more of each. A run of messages says its network where it changes. Pinning, archiving, snoozing, muting, labels and blocking change every chat. Opening it marks each chat read once its messages are shown: nothing until every chat and its first page have loaded, and a quieter chat whose messages are all from before what the others have loaded waits.
- **Sending.** A message goes by one chat: the one chosen in the composer, or by replying to a message in it, or the one a profile's Message or Open opened the pane on; otherwise one with a draft, then where they last wrote from, then the one opened. Each chat keeps its own draft and the composer shows the draft of the chat it sends on, so text typed for one network only goes on that one. Choices are named by network, account, and (for two chats on one account) who each is with, numbered in a fixed order if still alike; scheduled and cancelled messages say which chat they're for.
- **Profiles.** A direct chat's details, and a group sender's avatar or name, show the person's profile: their card's networks, each with its chat when there is one, and its numbers, emails and usernames; or, with no card, the contact's own profile and a way to add them to People (a new card, or the one they belong on). Adding is refused if another device has put them on a different card since.

A chat described before `dmGhostId` existed has none until its bridge host describes it again, which each host does once for every direct chat at its first start with the field.

## Messages, sending & scheduling

### Reading

- `api.messages.list({ chatId, paginationOpts })` returns newest-first pages (max 100 items / 8 MiB). Open `message.sealedEdit ?? message.sealed` with kind `message` and object ID `message.sealedEdit ? message.editEventId : message.sealedObjectId`.
- Companion queries: `api.messages.reactions({ chatId, messageIds })` (up to 100 IDs), `api.messages.receipts({ chatId })`, and `api.messages.typing({ chatId })`.

### Sending

```ts
const bridge = await convex.query(api.keys.bridge, {})
if (!bridge) throw new Error('This server isn’t set up to send yet.')
const bridgeKey = { publicKey: fromBase64Url(bridge.publicKey) }

const clientMessageId = crypto.randomUUID().replaceAll('-', '')
const plaintext: MessagePlaintext = { type: 'text', body }

await convex.mutation(api.messages.send, {
  chatId,
  clientMessageId,
  forBridge: sealJson(plaintext, [bridgeKey], {
    kind: 'outbound',
    ownerUserId: userId,
    objectId: clientMessageId,
  }),
  copy: sealJson(plaintext, [identity], {
    kind: 'message',
    ownerUserId: userId,
    objectId: clientMessageId,
  }),
  replyTo,
})
```

Delivery states shown for the member's own messages: `queued`, `claimed`, `submitted`, `sent`, `delivered`, `read`, `failed`, and `unknown`. Messages in `failed` or `unknown` can be discarded with `messages.discardSend({ clientMessageId })` or explicitly resent with a fresh `clientMessageId`.

### Scheduled sends

`scheduled.create`, `scheduled.list`, `scheduled.copies` (max 20 at once), `scheduled.cancel`, and `scheduled.sendNow` allow up to 500 scheduled messages per member, up to 365 days ahead.

## Labels, preferences, networks & demo data

- **Labels:** `labels.list`, `labels.create`, `labels.update`, `labels.remove` (up to 100 labels, 4 KiB sealed `{ name, color }` with kind `label`, object ID `labelKey`).
- **Preferences:** `preferences.get` / `preferences.set` (`{ sidebarLayout: 'simple' | 'focused' }`, default `'simple'`).
- **Networks & logins:** `networks.list`, `networks.health`, `logins.start`, `logins.session`, `logins.submit` (sealed to `bridgeKey`), `logins.cancel`, `logins.accounts`, `logins.logout`. Show a ToS warning before starting any network with `termsRisk: true`.
- **Server info & demo seeding:** `api.server.info` (public query returning `{ demo, invitations }`) and `api.demo.seedForMe` (only active when `TRIODITIS_DEMO=1` and `TRIODITIS_NETWORKS=fake`).
- **Google Contacts import:** `api.google.contacts` returns `{ clientId }` (a public Google Cloud OAuth Web client ID, or `null`), configured by admins via `api.google.setContacts({ clientId, sessionId? })`. When configured, clients authenticate directly with Google (`contacts.readonly`, returning the token in the URL fragment of `<origin>/google-contacts.html`) and import contacts client-side so the server never sees the OAuth token or plaintext contact cards.

For the full TypeScript types and Convex schemas, see [`packages/core/src/client.ts`](https://github.com/NotAKerbal/trioditis/blob/dev/packages/core/src/client.ts) and [`packages/backend/convex/`](https://github.com/NotAKerbal/trioditis/tree/dev/packages/backend/convex).

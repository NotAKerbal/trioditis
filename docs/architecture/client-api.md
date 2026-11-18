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

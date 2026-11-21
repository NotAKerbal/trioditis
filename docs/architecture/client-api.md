# Client API

What the desktop and web client (`apps/desktop`) calls, and how it opens what it gets
back. The functions are Convex functions in `packages/backend/convex`, imported as `api`
from `@trioditis/backend/api`; shared types come from `@trioditis/core`, and sealing from
`@trioditis/crypto`.

Every function needs a signed-in member of the server unless it says otherwise, and
refuses anyone else's data with the same error as a missing row. Errors are `ConvexError`s
whose `data` is one of two shapes: a sentence the UI can show as it is, or, for an error the
app acts on rather than only shows, `{ code, message }`, where `message` is the sentence to
show and `code` is what to branch on. So far the only code is `sessionChanged` (Keys, Key
writes are bound to the page's session). Any of those functions can also throw `You’re
signed out. Sign in again to continue.` and `Your account isn’t a member of this server.`;
each section lists the rest, word for word.

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

Better Auth trusts only `SITE_URL`, the app's origin, and refuses a request from any other
`Origin` (`/end-session` requires one even without a cookie). Per-worktree `pnpm dev` sets
`SITE_URL` to that worktree's own web app address, or to the backend's HTTP address when
there is no `apps/desktop`. The Electron shell, when it comes, loads the app from
`SITE_URL` with `loadURL`, never from `file://` or a custom scheme, which would send another
`Origin` (or `null`) and be refused.

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

| Convex env                             | Must be                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`                             | Exactly the origin the browser uses for the app, and so for auth. Better Auth refuses other origins and passkeys register to it                                                                                                    |
| (static JWKS)                          | Not supported yet: Convex refuses to deploy an auth config that reads an unset variable. A server that can't reach its own public address routes it to itself instead, as the self-hosted bundle does (Phase 1 follow-up)          |
| `TRIODITIS_DEMO`, `TRIODITIS_NETWORKS` | `TRIODITIS_DEMO=1` and no `TRIODITIS_NETWORKS` on preview and nightly deployments, for `demo.seedForMe`. `TRIODITIS_DEMO=1` alone turns invitations off. `TRIODITIS_NETWORKS` lists the networks the server runs a bridge host for |

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
| Add a passkey       | `authClient.passkey.addPasskey()` while signed in, with the page's session in `x-trioditis-session-id` (Key writes are bound to the page's session)                           |
| Change the password | `api.account.changePassword` (see Keys, Changing the password). Better Auth's own `changePassword`, password reset and `changeEmail` are turned off and answer 404            |
| Sign out            | `authClient.signOut()`. To end one particular session, see Ending a known session below                                                                                       |
| Who am I            | `api.members.me` returns `{ userId, sessionId, member }`, or `null` when signed out. `member` is `{ userId, role, identityKid }`, or `null` when the account isn’t a member   |
| Invite (admin)      | `api.members.invite({ email, role, sessionId? })` returns `{ invitationId, token }`. The token is returned once: build the link from it                                       |
| Invitations (admin) | `api.members.invitations` lists the server's invitations, without tokens. `api.members.revokeInvitation({ invitationId })`                                                    |

Sign-up without a valid token fails with Better Auth's `FORBIDDEN` and code
`INVITE_REQUIRED`.

`members.me` gives the account and its membership in one result, so the two always belong
together. `sessionId` is the Better Auth session the Convex token names, the same as
`session.id` from `authClient.getSession()`. When the screen says the account isn't a
member, sign out the account in that result, not whatever Better Auth's session cache holds
by then: another tab may have signed in as someone else.

### Ending a known session

`POST /api/auth/end-session` with the JSON body `{ "token": "<session.token>" }`, the token
read from `authClient.getSession()`. It ends exactly that session, whichever account the
request's cookie belongs to: holding the token is the authority. Use it when the session to
end may no longer be the cookie's, for example after another tab signed in as someone else.
Better Auth's own `revokeSession` can't do this: it acts only on the cookie's account and
answers `status: true` even when it deleted nothing.

| Status | Body                                                                       | Meaning                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `{ "result": "ended" }`                                                    | This request deleted the session                                                                                                                                                |
| 200    | `{ "result": "absent" }`                                                   | There is no session with that token (already ended)                                                                                                                             |
| 400    | Better Auth's error body, `"A session token is required."`                 | No token, or not a string of 1 to 256 characters                                                                                                                                |
| 403    | Better Auth's error body, `"Invalid origin"` or `"Missing or null Origin"` | No `Origin` header, `null`, or not the server's own origin. Go by the status, not the message: which one comes depends on whether a cookie, an `Origin` or a `Referer` was sent |
| 429    | The rate limit answer, with `Retry-After`                                  | This address's bucket is empty: 10 at once, then one every six seconds. Only where the proxy gives the client address: see Rate limits                                          |
| 5xx    | Any                                                                        | It couldn't tell: try again                                                                                                                                                     |

Only a 200 changed anything (`ended`) or confirmed there was nothing to change (`absent`);
any other answer means nothing was changed, or that it couldn't tell. The response never
sets or expires a cookie, so a late answer can't clear a sign-in made meanwhile in another
tab: the app clears its own state for the ended session itself. The `Origin` header is
required even without a cookie.

### Rate limits

Better Auth's rate limiting is on in every deployment, and its counts are kept in Convex (the
`rateLimits` table), so they last from one request to the next. Better Auth's own store is
memory, which a Convex HTTP action starts without. Each count is a token bucket that refills
steadily, so a client that slows down gets through at the refill rate, and one that stops
waits seconds, with no lockout to sit out.

| Routes                                                                                                                                                                              | Limit, each             | Counted by            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------- |
| `/sign-in/email`, `/sign-up/email` (which also redeems invitations and the setup token), `/passkey/generate-authenticate-options`, `/passkey/verify-authentication`, `/end-session` | 10 a minute, 10 at once | Client address        |
| Every other auth route                                                                                                                                                              | 300 a minute            | Client address        |
| `/sign-in/email`, `/sign-up/email`                                                                                                                                                  | 30 a minute, 30 at once | The email, lowercased |

`/sign-in/email` and `/sign-up/email` take only JSON (`Content-Type: application/json`, as
the app sends): Better Auth would also take a form, which the per-account limit can't read,
so anything else is refused with 415. Better Auth's `/verify-password` is turned off (404);
the current password is checked only by `account.changePassword`, which allows five checks a
minute per account and otherwise throws `Too many password attempts. Try again in N
seconds.` Requests to paths that aren't auth routes aren't counted.

If counting a request fails, the request fails (a 500) rather than going through uncounted:
a broken limiter keeps people from signing in instead of turning the limits off. Each such
failure is logged as `[rate limit] Couldn't count a request to <path>, so it was refused`,
with the error and never the key.

Over a limit, the answer is 429 with `{ "message": "Too many requests. Please try again later." }`
and `Retry-After` (and `X-Retry-After`) in whole seconds. Wait that long before trying again.

**The per-address limits are on only where a trusted proxy in front of the backend sets
`X-Trioditis-Client-IP`**, replacing any a client sent. The self-hosted bundle's Caddy will
set it, from the connection or, behind a proxy it trusts, from that proxy's
`X-Forwarded-For`, once that change lands in the install bundle. Until a proxy sets it,
replacing what clients send, only the per-account limit is reliable: a proxy that passes the
header through lets a client name any address it likes, or none. The client address is read
only from this header. A client can
send `X-Forwarded-For` and the like itself, so the backend reads none of them. IPv6 addresses
count by their /64. Convex passes request headers through as they are and adds no client
address of its own, so the header must come from the proxy, and the backend must be reachable
only through it: anyone who reaches it directly can name any address.

Without the header (in development, on previews and nightly, or behind a proxy that doesn't
set it), the per-address limits are off and only the per-account one applies. The other
choice, one bucket for every client, would let anyone keep everyone out by filling it.

**The per-account limit** bounds guessing at one account from many addresses. It is a
trade-off: anyone can use it up for someone else's email and keep them from signing in with
a password. So it is loose: it refills at 30 a minute, three times the per-address limit.
Where a trusted proxy gives the client address, one address alone can't keep an account
refused, but three or more together can take each token as it refills, and a real sign-in may
then lose the race for it; without the per-address limit, one address can. A passkey sign-in
isn't counted by it. The table holds SHA-256 hashes of its keys, never an email or address,
and buckets that have refilled are deleted every ten minutes.

Errors: `Only an admin can do that.` (`invite`, `invitations`, `revokeInvitation`) ·
`Invitations are turned off on demo servers.` · `That isn’t an email address.` · `That
invitation can’t be revoked.` · `Someone is signing up with that invitation right now. Try
again in a few minutes.`

## Keys

The person's **identity key pair** is what everything is sealed to. The private key exists
only on their devices. So a new device can get it, the server keeps it **wrapped**: by the
password, by the **recovery key**, and by any passkey that offers WebAuthn's PRF extension.
The server can't unwrap any of them.

`api.keys.identity` returns `{ state, publicKey, kid, backups }`. What to do for each
`state`:

| `state`       | Means                                                | The UI                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`        | No identity key yet                                  | First-device setup, below                                                                                                                                                                                               |
| `needsBackup` | A key, but not both a password and a recovery backup | On a device that has the key: make the missing backups and call `keys.setup` with a proof. On a device that doesn't: say "finish setup on the device you first used". Connecting networks is blocked until this is done |
| `ready`       | Key and both backups                                 | On a new device, unlock with the password, the recovery key or a passkey backup                                                                                                                                         |

### First device

```ts
const identity = generateKeyPair()
// The password and recovery-key backups. It opens both again before returning, and throws
// unless both give back this key: the server can't check them.
const { args, recoveryText } = makeKeySetup(identity.privateKey, pw, userId) // show recoveryText once
// Prove the device holds the key: the challenge is sealed to the key being set up.
// sessionId: members.me's, from when the page opened (Key writes are bound to the page's session).
const { sealed } = await convex.mutation(api.keys.challenge, { publicKey: args.publicKey, sessionId })
const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
await convex.mutation(api.keys.setup, { ...args, proof, sessionId })
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
const { sealed, expiresAt } = await convex.mutation(api.keys.challenge, { sessionId })
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
forgives case, spaces, dashes and look-alike letters, and its checksum catches typos. A
passkey backup opens with `passkeyKey(prfOutput)` as the wrapping key (Passkeys, below).

### A new recovery key, or a passkey

Wrap again and call `api.keys.putBackup({ kind: 'recovery' | 'passkey', nonce, ct,
credentialId?, prfSalt?, proof, expectedRevision, sessionId })`. It replaces that backup and returns
its new `revision`. `expectedRevision` is the `revision` of the backup being replaced, as
`keys.identity` showed it (0 for a new passkey). If another device changed it meanwhile, the
call is refused: reload and try again. `api.keys.removePasskeyBackup({ credentialId,
proof, sessionId })` removes a passkey backup. Password and recovery backups are replaced, never
removed.

Revisions only go up and are never reused, across all of the person's backups: a new or
replaced backup takes the next one, which needn't be the old revision plus one, and a
passkey backup removed and made again gets a new one, so a device still holding the old
revision is refused. A passkey backup needs `credentialId` (base64url, at most 512
characters) and a 32-byte `prfSalt` (base64url); a person can have at most 10.

### Passkeys

A passkey signs in (`authClient.signIn.passkey()`), and one whose authenticator offers
WebAuthn's **PRF** extension can also unlock the identity key, so a new device needs no
password. The PRF output for an input is a secret only that passkey can produce; it never
leaves the device. `passkeyKey(output)` (packages/crypto) turns it into a wrapping key, and the
key is wrapped with it as a `passkey` backup for that credential:

```ts
await ready()
const first = passkeyPrfSalt() // the PRF input; the same everywhere (below)
const { data, error, webauthn } = await authClient.passkey.addPasskey({
  extensions: { prf: { eval: { first } } },
  returnWebAuthnResponse: true,
}) // with the page's session in x-trioditis-session-id (Key writes are bound to the page's session)
if (error || !webauthn) return // cancelled, or refused (a 409 sessionChanged: reload)
const output = webauthn.clientExtensionResults.prf?.results?.first
// No output: the passkey signs in, but makes no backup yet (see below).
if (!output) return
const context = { userId, kid, kind: 'passkey' } as const
const wrappingKey = passkeyKey(new Uint8Array(output))
const wrap = wrapIdentityKey(identity.privateKey, wrappingKey, context)
// Open it again before sending, as for every backup: the server can't check a wrap.
unwrapIdentityKey(wrap, wrappingKey, context, identity.publicKey)
await convex.mutation(api.keys.putBackup, {
  kind: 'passkey',
  ...wrap,
  credentialId: webauthn.response.id,
  prfSalt: toBase64Url(first),
  proof,
  expectedRevision: 0,
  sessionId,
})
```

- **The PRF input is fixed**: `passkeyPrfSalt()`, a constant 32 bytes, for every person and
  passkey. Signing in doesn't know whose passkey it is until the server answers, so only an
  input known in advance can be evaluated in the sign-in touch itself. Pass it to
  `signIn.passkey({ extensions: { prf: { eval: { first } } }, returnWebAuthnResponse: true })`,
  and the same touch that signs in gives the output that opens the key. The input needn't be
  secret or unique: each credential's PRF is keyed by its own secret, so each passkey still
  gives its own wrapping key. Each backup keeps the input it was made with (`prfSalt`); a
  backup with another input is opened by asking its passkey again, with `evalByCredential`.
- **Not every authenticator gives the output when the passkey is made.** Some give it only
  when the passkey is next used, and some (or the browser) not at all. Without it, the passkey
  still signs in; offer to make its backup later with a `navigator.credentials.get()` naming
  that credential (`allowCredentials`) and the input (`prf.evalByCredential`). That ceremony
  goes nowhere near the server: only the output matters, and only the device uses it.
- **Unlocking with a passkey** on a new device: from the sign-in touch's output if it came with
  one and the backup for that credential used the same input, or else with a
  `navigator.credentials.get()` naming this key's passkey backups and their inputs. The
  credential that answered picks the backup. A passkey backup opens without its passkey being
  registered for sign-in: it's the output that opens it.
- **A passkey backup is only for a passkey on the account.** `keys.putBackup` with
  `kind: 'passkey'` is refused (`That passkey isn’t on your account any more…`) unless
  `credentialId` is a passkey Better Auth has for the signed-in person, checked in the same
  transaction as the write: so a backup is never made for another account's credential, nor
  lands after its passkey was removed.
- **Listing**: `api.keys.passkeys({ sessionId })` returns the person's passkeys as
  `{ credentialId, name, createdAt, backedUp }[]`, where `credentialId` matches a backup's.
  Use it rather than Better Auth's `/passkey/list-user-passkeys`, which answers for whoever the
  cookie signs in as by now.
- **Removing**: `api.keys.removePasskey({ credentialId, proof, sessionId })` removes the
  passkey's backups and its sign-in credential in one transaction, so nothing is left half
  removed. A credential no longer registered just loses its backups. Better Auth's own
  `/passkey/delete-passkey` removes only the sign-in credential; don't use it.
- **One passkey ceremony at a time, in the whole browser.** Better Auth keeps the challenge
  of a sign-in or a registration in one cookie every tab shares, so a second ceremony under
  way at once would replace the other's challenge and make both fail; and the registration
  header is the page's. The desktop app holds a Web Lock (`trioditis-passkey-ceremony`) for
  each whole sign-in or registration and refuses a second one, in any tab, while it's held.
  (Unlocking with a passkey makes no request, so it takes no lock.)
- **A recent sign-in.** Better Auth adds a passkey only for a session made in the last day
  (`SESSION_NOT_FRESH` otherwise): say to sign in again.
- **Known gap:** the session check (Key writes are bound to the page's session) runs before
  Better Auth stores the credential, in a separate step. A sign-out of that same session in
  another tab in the instant between them can let the credential land just after the session
  ended. It still lands on the same account, made by that person's own authenticator.

### Key writes are bound to the page's session

`keys.challenge`, `keys.setup`, `keys.putBackup`, `keys.removePasskeyBackup`,
`keys.removePasskey`, `keys.passkeys` (a query), `account.changePassword`, `logins.start`, `labels.create`, `demo.seedForMe`,
`preferences.set`, `members.invite` and `mcp.authorize` (the agent consent page's approval)
take an optional `sessionId`: pass the `sessionId` from
`members.me` that the page opened with. Tabs share the Convex client, so another tab
signing in as someone else can switch the token the page's calls run as while the page still
shows the first account; a key or backup meant for one account would then be written to the
other, which can never open it, or a network connected to the other account, whose key then
seals what it brings in, or a label or demo data sealed to the wrong key, or a setting or an
invitation made as the wrong person, or an agent given the wrong account's chats. The others act only on an ID the page already holds,
which each checks belongs to the caller, so a switched page finds nothing to change. With `sessionId`, the call is refused before it writes
anything unless it runs as that same Better Auth session, with `ConvexError` data
`{ code: 'sessionChanged', message: 'This page’s session has changed. Reload the page.' }`.
A session that has ended is refused the same way. The actions, `account.changePassword` and
`demo.seedForMe`, check again inside each transaction that writes, so a session that ends
while one runs is refused there too. Reload the page then: it reads `members.me`
again. Without `sessionId` the call isn't bound to a session, though it still needs a
signed-in member as usual; it will become required once every client sends it. Pass it on
every one of these calls.

Adding a passkey goes through Better Auth's routes, not Convex, so the page's session goes in
a header instead: `x-trioditis-session-id: <sessionId>` on `/passkey/generate-register-options`
and `/passkey/verify-registration`. If the cookie's session isn't that one, both answer 409
with `{ "code": "sessionChanged", "message": "This page’s session has changed. Reload the
page." }`. That refusal stores and refreshes nothing: no challenge is made, no session is
extended or ended, and no cookie is set (the rate limit may still count the request, and a 429
can come first). A bearer token sent alongside is refused the same way, since the page signs
in with its cookie. So is a session within a minute of expiring: if it had expired by the time
Better Auth reads it again, Better Auth would answer by clearing the sign-in cookies, and a late
answer like that could clear another tab's newer sign-in. For the same reason, any failed answer
on these two routes, with the header, never carries a cookie that clears the sign-in; the
passkey challenge's own cookie is kept. (The
passkey plugin already refuses an answer from another account than its challenge's.)
`addPasskey` passes its own fetch options only to the second step, so set the header for both
in the auth client's `fetchOptions.onRequest`, from the session the page opened with:

```ts
createAuthClient({
  plugins: [convexClient(), passkeyClient()],
  fetchOptions: {
    onRequest: (context) => {
      if (REGISTRATION_PATHS.some((path) => String(context.url).includes(path)) && registeringAs)
        context.headers.set('x-trioditis-session-id', registeringAs)
    },
  },
})
```

The desktop app sets `registeringAs` only while it adds a passkey (`asSession` in
apps/desktop/src/lib/auth-client.ts).

Without the header nothing is checked, as before.

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
  sessionId,
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
`You can have at most 10 passkey backups. Remove one first.` · `A password backup needs its
password settings.` (a defensive check: the arguments of `keys.setup` and
`account.changePassword` always include the settings, so a client never sees it)

## Preferences

| Function              | Arguments                        | Returns                                                                                              |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `api.preferences.get` | none                             | `{ sidebarLayout: 'simple' \| 'focused' }`. **`simple` is the default** for anyone who hasn't chosen |
| `api.preferences.set` | `{ sidebarLayout?, sessionId? }` | `null`. Changes only what it's given                                                                 |

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

`api.chats.list({ view?, network?, labelId?, order?, paginationOpts })` returns a page
`{ page: ChatRow[], isDone, continueCursor }` (use `usePaginatedQuery`; default `inbox`).
The list is the view's pinned chats, most recent first, then the rest, most recent first,
paged as one list: pins that don't fit on the first page carry on to the next, and none is
left out. A page holds at most 50 chats (`numItems` above 50 counts as 50) and reads at most
8 MiB, so it can end early: keep loading with the cursor. A page reloaded with an
`endCursor` range (as `usePaginatedQuery` does) isn't limited by `numItems`; it holds at
most 51 chats, and when it reaches that it ends early with `pageStatus: 'SplitRequired'`
and a `splitCursor`, which `usePaginatedQuery` uses to split it. With `network`, only that
network's chats, in the same order. With `order: 'recent'`, the view's chats most recent
first, pinned or not, paged the same way (the Focused sidebar's inbox). With `labelId`, the
chats with that label in the view, in the order they were labelled, pinned or not, whatever
`order` says.

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
| `lastMessage`                                | The newest message, for a preview: see below. `null` when the chat has no messages                                                                  |

#### The last message

`lastMessage` is the chat's newest message, the one `messages.list` shows first (by
`sortKey`, imported history included), or `null` when the chat has none:

```ts
interface LastMessage {
  messageId: Id<'messages'> // the message's `_id` in `messages.list`
  at: number // its `networkTs`
  self: boolean // `sender` is `{ self: true }`
  ghostId?: string // otherwise `sender.ghostId`
  redacted: boolean // deleted for everyone: show "Message deleted"
  sealed: Envelope | null // `sealedEdit ?? sealed`
  objectId: string // `editEventId` for an edit, else `sealedObjectId`
}
```

Open it exactly as the message (see Reading): kind `message`, object ID `objectId`.

```ts
const last = row.lastMessage
const preview = last?.sealed
  ? openJson<MessagePlaintext>(last.sealed, identity, { kind: 'message', ownerUserId: userId, objectId: last.objectId })
  : null
```

`sealed` is `null` when the message was deleted (`redacted: true`), and when its envelope is
over 4 KiB as stored (its JSON in UTF-8), which a text message almost never is: show
"Message" then, and open the chat for the rest. Everything else is there either way.

It is kept live: a new message, an edit of the newest one, the network's echo of a send
(the same `messageId`, with the network's time and content), a deletion, and a discarded send
(the one before it takes over) all change the row, as any change to a chat does. A message
that arrives late with an older time never replaces a newer one. Because it includes
imported history and the person's pending sends, `lastMessage.at` can differ from
`lastMessageAt`, which orders the inbox.

The server keeps it as a small pointer on the chat, so the list reads no messages. A row is
at most about 18 KiB with the largest sealed metadata (8 KiB) and preview (4 KiB), so a full
page of 50 is under 1 MiB, far inside its 8 MiB. A backend upgraded from before it gives
each chat its pointer in `migrations:runAll`, after the deploy. Until then an older chat's
`lastMessage` is `null`, unless a message arrives in it, is echoed, edited, redacted or
discarded; other changes (pinning the chat, a send's delivery status) don't fill it in.

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
  (a message with more shows its first 100, plus up to 20 of the person's own that those
  left out, so they can always take theirs away). `senderKey` is `self` or `ghost:<ghostId>`.
  It never reads the messages themselves, and reads at most 8 MiB of reactions, going
  through the IDs in order, so it answers a prefix of `messageIds`:
  - **The first ID is always answered** unless it is a deleted message: one message's
    reactions (at most 120 rows of at most 4 KiB) always fit. So a first ID missing from
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

### Arrivals

`api.messages.arrivals({})` is what notifications watch. It returns an `ArrivalFeed` from
`@trioditis/core`, `{ latest, arrivals }`:

- `arrivals`: the newest messages from other people, by when the server stored them (not
  network time), at most ten, each `{ arrivedAt, message, chat }`. `message` is a
  `LastMessage`, opened the same way, with `sealed` null when it's too large to show;
  `chat` is the chat's `ChatRow`. Imported history, the person's own messages, deleted ones
  and chats outside the inbox are left out. It looks through at most 50 live messages and
  8 MiB of them to find the ten. Muting is the client's to check (`mutedUntil`), since a
  query doesn't rerun when a mute runs out.
- `latest`: when the newest live message of any kind arrived, the person's own included, or
  null if none has. It doesn't move when a chat changes view.

Keep `latest` from the first answer as a cursor and notify for arrivals after it, moving it
on with each answer. So opening the app announces nothing, and an old message that comes
into view later, its chat brought back from the archive, doesn't notify. `arrivedAt` is when
the storing mutation started, not when it committed, so a message can appear after a newer
one with an earlier time: count arrivals up to ten seconds behind the cursor too, once each
(apps/desktop `newArrivals`). More than ten arriving between two answers notify only for the
newest ten.

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
  set up yet. The client then can't seal sends or login input, so it should keep those
  disabled. The server doesn't check this for it: `logins.start` still queues a login
  without a bridge key, which can't get past a step that needs input.

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
| `read`              | Read. Set by someone else's read receipt (`receipt` event) covering the message, as well as by `sendStatus`; never lowered after                                                                                                                                          |
| `failed`            | Not sent. Offer **Retry** (a new send with a new `clientMessageId`) or **Delete** (`messages.discardSend`)                                                                                                                                                                |
| `unknown`           | **May not have sent.** Trioditis never resends on its own, because the network may have it. Offer "Send again" (a new `clientMessageId`, which may duplicate) or "Discard" (`messages.discardSend({ clientMessageId })`). A late confirmation can still move it to `sent` |

A send that couldn't go out within 24 hours becomes `failed` (never sent) or `unknown` (it
may have reached the network), at that deadline whether or not a gateway is running, with
two exceptions. One a gateway was handing over at the deadline waits for that handover's
lease (at most 30 seconds), so the bridge host's answer for it still counts. And one queued
by a version from before these deadline jobs ends at the gateway's next claim until
`migrations.scheduleCommandDeadlines` has been run on the server. One the bridge host took
but never reported on becomes `unknown` an hour after the deadline, on the same terms.

Errors: `That chat doesn’t exist.` · `That message ID isn’t valid.` (16 to 64 letters,
digits, `-` or `_`) · `That message isn’t sealed, or is too long.` · `That message can’t be
replied to.` · `Only a message that failed or may not have sent can be discarded.` · `This
message reached the network, so it can’t be discarded here.` · `Ask for at most 100
messages’ reactions at once.` (`reactions`)

### Reacting

`api.messages.react({ chatId, messageId, key, remove? })` asks the bridge host to add the
person's reaction `key` to a message, or with `remove: true` to take it away. The message must
be in that chat, have reached the network and not be deleted. `key` is one emoji (or a
network's short name for one): 1 to 64 characters, with no spaces or control characters. Send
the emoji as picked; the bridge host compares keys without variation selectors, so taking
away a reaction works with the stored key too.

Nothing is stored until the bridge host's echo, a `reaction` or `reactionRemove` event, so
`messages.reactions` changes only then. A network that allows one reaction per person (most
do) replaces the old one, and the bridge host reports the old one's removal. The command has
a 10-minute deadline: one that hasn't reached the bridge host by then isn't sent, and it is
never sent again. The desktop app shows the person's choice at once and goes back to what the
server says if no echo comes within 30 seconds (`apps/desktop/src/data/reaction-toggle.ts`).

A network without reactions (`NETWORK_INFO[network].reactions` is false: Google Voice,
Bluesky) refuses it, and the client offers none there.

Errors: `That chat doesn’t exist.` · `<Network> doesn’t have reactions.` · `That reaction
can’t be sent.` · `That message can’t be reacted to.`

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

| Function        | Arguments                          | Returns                                                       |
| --------------- | ---------------------------------- | ------------------------------------------------------------- |
| `labels.list`   | none                               | `[{ _id, labelKey, sealed, createdAt }]`                      |
| `labels.create` | `labelKey`, `sealed`, `sessionId?` | The label's ID (the same one again for a repeated `labelKey`) |
| `labels.update` | `labelId`, `sealed`                | `null`. Seal with the same `labelKey`                         |
| `labels.remove` | `labelId`                          | `null`. Also takes it off every chat                          |

At most 100 labels of up to 4 KiB each. `labels.remove` takes the label off its first 1,000
chats at once and the rest in batches straight after; until then a chat may still list the
removed label's ID in `labelIds`. Show only labels that `labels.list` returns.

Errors: `That label ID isn’t valid.` · `That label isn’t sealed, or is too long.` · `You can
have at most 100 labels.` · `That label doesn’t exist.`

## Networks and connecting accounts

`api.networks.list` returns the networks people can connect here: the ones an admin installed
(Admin settings → Networks, below) that the server runs a bridge host for:

```ts
{ network, name, maturity: 'stable' | 'beta' | 'experimental',
  flows: [{ id, kind: 'qr' | 'phone' | 'cookies' | 'form', name }], termsRisk, reactions }
```

The same table is `NETWORK_INFO` in `@trioditis/core`. Show a warning before connecting a
network with `termsRisk` (cookie or token logins can get an account banned). `reactions` is
whether the network has them (Reacting).

### The login stepper

1. `const loginSessionId = await convex.mutation(api.logins.start, { network, flowId?, sessionId })`.
   It needs `keys.identity` in state `ready`. `flowId` is one of the network's `flows` ids
   from `networks.list`; without it, the bridge host uses the network's default login.
2. Watch `api.logins.session({ loginSessionId })`. It returns
   `{ _id, network, state, step, updatedAt, hostLastSeenAt, hostOnline }`, or `null` for a
   login that doesn't exist or isn't the person's. `hostLastSeenAt` is when the bridge host
   running it (before one has it, the network's most recently seen host) was last heard from,
   or `null`; `hostOnline` is whether that was within two minutes (`BRIDGE_HOST_STALE_MS`) when
   the query ran. A host that has gone can't finish the login, so hide a QR or pairing code it
   showed once `hostOnline` is false or two minutes pass with no new `hostLastSeenAt`. Likewise a
   `step.expiresAt` or `display.expiresAt` (bridge host time, ms) that has passed, where the
   bridge host sends one. `state` is one of `pending`, `active`, `complete`, `cancelled` or
   `error`. `step` is `null` until the bridge host sends the first step (while `pending`);
   then render it (the `LoginStep` type in `@trioditis/core/bridge-protocol`):
   - `displayAndWait`: with `display.type` `qr`, draw `display.data` as a QR code; with
     `code`, show it big, for typing on the phone; with `emoji`, show it to compare
   - `userInput`: a form from `fields` (`id`, `type`, `name`, `description?`, `pattern?`)
   - `cookies`: with `cookies.browser`, show the sign-in browser: get a ticket and an
     admission from `api.logins.openBrowser({ loginSessionId, stepId, sessionId })` and open
     the `/login-browser` websocket with them (signin-browser.md, Tickets). The person signs in on the site
     and the bridge host submits what it needs itself, so there is nothing to submit here.
     Offer pasting the listed cookies from `cookies.url` as the fallback, and only that when
     `browser` is absent. With `cookies.hidden` (and `browser`), say it's working: the step
     runs by itself
   - `complete`: done, the account is connected
   - `error`: show the message for `step.error` (an error code; see bridge-protocol.md,
     Errors) and offer to start again
3. Submit what the person entered (a form, or pasted cookies), sealed to the bridge key,
   since it's a credential:

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

4. Cancel with `api.logins.cancel({ loginSessionId })`. The login is `cancelled` at once,
   and later steps for it are ignored; it returns `cancelled`, or `complete` or `error` if the
   login had already ended that way (then it changes nothing). Cancelling again is the same.
   A login the bridge host finishes before the cancel reaches it is logged out when it
   reports in, unless it reconnected an account the person already had, which stays connected.

Accounts: `api.logins.accounts` returns
`[{ _id, network, state, error, lastHealthyAt, updatedAt, hint, logoutPending, logoutError }]`.
`hint` tells the person's accounts on one network apart: the phone number on WhatsApp, whose
login ID is one, otherwise `ID …` and the login ID's last four characters (no account name is
stored). The login ID itself isn't returned.
`state` is `CONNECTED`, `CONNECTING`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS` (reconnect
it), `UNKNOWN_ERROR` or `LOGGED_OUT`. `api.logins.logout({ networkAccountId })` disconnects
one, returning `queued`, `pending` (one is already on its way) or `loggedOut` (nothing to do):
`logoutPending` is true until the bridge host confirms; if it couldn't (rejected, or no
bridge host took it within 10 minutes: `expired`; or one took it but never confirmed, an
hour after that: `timeout`), `logoutPending` goes false and `logoutError` says why. Both
happen on time whether or not a gateway is running, with the same two exceptions as sends: a
logout a gateway is handing over at the deadline waits for that lease (at most 30 seconds),
and one queued before deadline jobs existed is settled either by the gateway's sweep, if a
gateway is running, or once the migrations run (`migrations:runAll`, which `pnpm dev` and
the installer run after each deploy), whichever comes first.

Errors: `That network isn’t installed on this server.` · `Finish setting up your key, with
its password and recovery key, before connecting a network.` · `That isn’t a login method
this network offers.` · `That step of the login is over. Start again if it didn’t finish.` ·
`That input isn’t sealed, or is too long.` · `That’s already been sent. Wait for the next
step.` (a second submission for the same step) · `That step of the login can’t be opened in
a browser. Start again if it didn’t finish.` (`openBrowser`) · `That login doesn’t exist.` ·
`That account doesn’t exist.`

### Health

`api.networks.health` returns, for each network in `networks.list`,
`{ network, bridgeOnline, bridgeLastSeenAt, accounts: [{ networkAccountId, state, error, lastHealthyAt }], status }`:

| `status`   | Means                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `online`   | The bridge host is up and all the person's accounts on it are connected    |
| `degraded` | Some are connected, some aren't                                            |
| `offline`  | The bridge host is down, or none of the accounts is connected: "1 offline" |
| `none`     | The person hasn't connected this network                                   |

`bridgeOnline` goes false two minutes after the bridge host's last heartbeat. Queries rerun
when data changes, not when time passes, so a host that stops heartbeating stays
`bridgeOnline` in an answer already given. A live host's heartbeat changes
`bridgeLastSeenAt` (null if never heard from) every 30 seconds, so treat the bridge as down
once two minutes (`BRIDGE_HOST_STALE_MS`) pass by the client's clock without a new one, and
recompute `status` with `networkStatus` from `@trioditis/core`. Timing it from when the
client got the value, not from the value itself, keeps a fast or slow client clock from
misjudging it.

### Installing networks (admins)

The server runs a bridge host for each network in `TRIODITIS_NETWORKS` (the installer runs
one for every network unless the operator narrows it; docs/deploy.md). Admins choose which of
those people can connect:

- `api.networks.catalog` lists every network Trioditis knows, for the admin panel:
  `{ network, name, maturity, termsRisk, installed, bridged, bridgeOnline, bridgeLastSeenAt, accounts }[]`.
  `bridged` says the server runs its bridge host; one it doesn't can't be installed, and the
  operator adds it with the installer (Telegram also needs its API ID and hash). `accounts`
  counts the accounts connected to it, everyone's together; never whose.
- `api.networks.install({ network, sessionId? })` installs one: it appears in
  `networks.list` for everyone. Installing one already installed does nothing.
- `api.networks.remove({ network, sessionId? })` removes one: nobody can start connecting it,
  logins in progress on it end (`cancelled`), and every account on it, anyone's, gets a logout
  as if its owner had disconnected it. The logouts go out in batches just after it returns; an
  account whose login finishes anyway is logged out as soon as it reports in. Chats stay; what
  the bridge host sends before a logout lands still arrives.

All three are for admins only (`Only an admin can do that.`). Errors: `This server doesn’t run
a bridge for <network>, so it can’t be installed here.`

A server upgraded from before admins installed networks keeps the ones people had connected:
the migrations install each network with an account that isn't logged out.

## Demo data

For previews and the nightly. `api.demo.seedForMe({ sessionId? })` (an action) gives the
signed-in person a connected account on each of seven networks (WhatsApp, Signal, Google
Messages, Telegram, Instagram, Slack and Messenger), with six contacts and eight chats (two
groups, a pinned chat, a message request, a snoozed chat and an archived one) of 20
messages each. The fixtures are made-up text sealed on the server to the person's identity
public key, so they open like anything else. It needs `keys.setup` done first and works only
where `TRIODITIS_DEMO=1` and no bridge host is configured (`TRIODITIS_NETWORKS` empty or
unset; exactly when `server.info` says `demo: true`), so no real account can be there. The
accounts look connected, but no bridge host runs them. The contacts, and each chat with its messages, are written whole, so a call
that fails partway leaves no half-written chat, and calling again finishes the rest. Once
everything is there, a call does nothing (`{ seeded: false }`). Errors: `Demo data is only
available on demo deployments.` · `Set up your key first (keys.setup), then load the demo.`

- **Previews** create a known test account by script, on one account in one process, so it
  can leave out `sessionId` (a page always passes it): sign up with
  `authPassword(password, email)` and the setup token, call `keys.challenge({ publicKey })`
  and open it with `keyPairFromPrivateKey(privateKey)`, call `keys.setup` with
  `{ ...makeKeySetup(privateKey, password, userId).args, proof }` (the same password backup
  the browser unlocks, plus a recovery backup; `makeKeyBackup` gives the password backup
  alone), then call `demo.seedForMe`.
- **The nightly** has no test account: its first admin signs up with the setup token, sets up
  their key in the app as on any first device, and calls `demo.seedForMe`.

## Contacts

Contact profiles (name, handle, avatar) are sealed with kind `contact`, object ID `ghostId`;
the plaintext is `ContactPlaintext`. A profile is shared: every member who has the contact gets
the same one. What each of the person's own logins knows a contact by is sealed apart, to the
person only (object ID `<ghostId>/identifiers/<loginId>`, plaintext
`ContactIdentifiersPlaintext`: URIs such as `tel:+15551234567`), since what each login can see
differs. Each login's is its own row, replaced only by that login's, and needs no profile first.

| Function               | Arguments                           | Returns                                                                                  |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `contacts.get`         | `network`, `ghostIds` (at most 100) | `[{ ghostId, sealedProfile }]` for the ones the person has a contact for on that network |
| `contacts.list`        | `paginationOpts` (up to 500 a page) | `{ network, ghostId, sealedProfile }` pages, every network, in no meaningful order       |
| `contacts.identifiers` | `paginationOpts` (up to 500 a page) | `{ network, ghostId, loginId, sealed }` pages: each login's identifiers for a contact    |
| `contacts.sync`        | `networkAccountId`                  | `{ queued }`. Sends that account's contacts' numbers again; within ten minutes, nothing  |

A message's sender is `{ ghostId }` on its chat's network, so the client collects a page's ghost
IDs and asks `contacts.get` once (the desktop app does this in group chats, to name each sender
beside an avatar, with its picture: see Media). Each profile is at most 8 KiB.

The address book reads every page of `contacts.list` and `contacts.identifiers` to match contacts
to its cards (People). A page can come back short, or empty, before the end; keep going while
`isDone` is false.

Identifiers come only from what a login's own chats carry: on networks where a contact's ID can
be their phone number (WhatsApp, for a contact not hidden behind a LID; `CONTACT_LIST_NETWORKS`),
each new contact comes with that number, sent once per login, and `contacts.sync` sends them again
for the contacts in that account's chats. Networks' own contact lists aren't used yet: each
connector's reaches past the login that asks (Telegram's changes the profile every member sees,
WhatsApp's fills numbers in from a map the whole host shares, Signal's adds a username from the
shared profile, Google Messages's logs numbers), so they wait for those connectors to be patched.

Errors: `Ask for at most 100 contacts at once.` · `That account doesn’t exist.` · `That account
isn’t connected.`

## People

The person's address book: a card for each person they know, whatever networks they're on.
A card's plaintext is `PersonPlaintext` (packages/core, `people.ts`), modelled on vCard: name
and its parts, nickname, organization and title, phone numbers, emails, usernames, websites and
addresses (each with a label), birthday, note, a small photo, and `links`, the network contacts
(`{ network, ghostId }`) the card is about. Each card is sealed to the person only (kind
`person`, object ID `personKey`, which the client picks: 16 to 64 letters, digits, `-` and `_`),
so the server stores ciphertext and how many cards there are, never who is on them or which
contacts a card links.

| Function          | Arguments                                                                 | Returns                                                                        |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `people.list`     | `paginationOpts` (up to 100 a page)                                       | `{ personKey, sealed, updatedAt }` pages, in `personKey` order                 |
| `people.revision` |                                                                           | The address book's revision                                                    |
| `people.put`      | `people: { personKey, sealed }[]` (at most 100), `revision`, `sessionId?` | The new revision. Adds cards or replaces the ones with those keys, all or none |
| `people.remove`   | `personKeys` (at most 100), `revision`                                    | The new revision. A key with no card is skipped                                |

A sealed card is at most 64 KiB, and a person can have at most 10,000. `people.put` takes the
page's `sessionId`, like the other sealed writes, and refuses it once the browser has signed in
to another account.

Every write names the revision it was worked out from, and is refused with code
`people_changed` if the address book has moved on (another device wrote to it). The server
can't check links itself, since they're sealed; this is what keeps two devices from linking one
contact to two cards. The client waits for the new revision and its cards, and works the change
out again: a link is moved again, an import carries on from the call that was refused, and an
edit to a card that changed meanwhile is given up, for the person to look at first.

Matching happens on the device, since only it can open both sides (packages/core):

- **Import and export.** `parseContactsFile` reads a vCard file (2.1, 3.0 and 4.0: what iPhone,
  iCloud, Android, Google Contacts, Outlook and macOS export) or a Google Contacts or Outlook
  CSV. Importing a card whose UID matches one already here replaces its fields with the file's,
  keeping its links (and its photo, if the file has none); a UID the file repeats is one card.
  `toVCards` writes vCard 3.0. The desktop app makes imported photos 128 pixels at most.
- **Suggested links.** `suggestLinks` suggests a card for each contact on none that shares a
  phone number, email or username with it, or failing that has exactly the same name as one
  card. Numbers match with or without their country code (the shorter must end the longer;
  two with country codes must be equal). The person confirms every link; the app can link all
  the matches that aren't by name and point at one card only, in one go.
- **Not in People.** `groupUnlinked` groups the contacts on no card that share an identifier
  exactly, so one person on several networks becomes one card (`cardFromContacts`). A number
  saved without its country code can end two different full numbers, so it never joins them.
- A contact is on one card at most: linking it to a card takes it off any other
  (`moveLinks`).

Errors: `Your people changed on another device. Try again.` (`people_changed`) · `That person
ID isn’t valid.` · `That person isn’t sealed, or is too long.` · `Each
person can be saved once per call.` · `Save at most 100 people at once.` · `Delete at most 100
people at once.` · `You can have at most 10,000 people.`

## New chats

A chat starts on one of the person's connected accounts, with one of their contacts there or
with whoever a phone number or username belongs to. The identifier is sealed to the
bridge key (kind `outbound`, object ID `requestId`, plaintext `{ identifier }`), so the server
never sees it.

| Function          | Arguments                                                                                                  | Returns                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `newChats.start`  | `networkAccountId`, `requestId` (16 to 64 of `A-Za-z0-9_-`), `ghostId` or `sealedIdentifier`, `sessionId?` | null. The same `requestId` again does nothing                             |
| `newChats.status` | `requestId`                                                                                                | `{ state: 'pending' \| 'started' \| 'failed', chatId?, error? }`, or null |

The client watches `newChats.status` until it's `started` (open `chatId`; a chat the person
already has with them is given as it is) or `failed`, with an error code: `not_found` (nobody
on the network has that identifier), `invalid_identifier` (it isn't written as a number or
username the network takes), `unsupported`, `not_connected`, `rate_limited`,
`network_rejected`, `timeout` (the network took over two minutes, or no host reported back), or
`expired` (no bridge host took it in ten minutes; one that does later doesn't start it). Only
the host the command went to can answer it.

What a chat can start from depends on the network's connector (`START_TARGETS` in
packages/core, mirroring the bridge host's `startTargets`): WhatsApp and Google Messages take a
contact or a phone number; Signal a contact, a phone number or a username; Telegram, Messenger,
Instagram, Slack and LinkedIn a contact; X a username. The bridge host passes a number on as digits with
its `+` (Signal needs the country code) and a username without its `@`, checked against the
network's own username grammar. A number's formatting (spaces, dashes, dots, brackets, `tel:`,
`00` for `+`) is taken off first; anything else is `invalid_identifier` (it could be one of the
connector's own IDs: WhatsApp would resolve a LID, filling in its number from a map the whole
host shares, and Google Messages looks dotted IDs up among every login's contacts). Telegram's identifier lookup reads a phone table the whole host shares, Google Voice's
chats are keyed by phone number (which bridgev2 logs), Meta's connector resolves only numeric
IDs and X's only screen names, so those are left out. A contact's chat can start on any of the person's accounts on
that network; `contacts.list` gives the ones whose logins sent the contact (`networkAccountIds`),
and the desktop app offers those first, letting the person choose when there's more than one
account, since some networks' contact IDs belong to one login. The desktop app offers a card's linked
contacts first, then its numbers on networks that take them, then its usernames on their own
network, on the first account there. A `ghostId` must be one of the person's contacts on that
account's network. A person can start 20 chats a minute; requests are kept a day. The bridge
host silences connector logging while it resolves an identifier, since what connectors log can
include it (whatsmeow's own debug output still names it: never run WhatsApp with `--verbose` in
production).

Errors: `That request ID isn’t valid.` · `Start a chat with a contact or a sealed identifier.` ·
`That account doesn’t exist.` · `That account isn’t connected.` · `That identifier isn’t
sealed, or is too long.` · `That contact doesn’t exist.` · `Too many new chats. Wait a minute,
then try again.`

## Server updates

Admin settings → Updates (`docs/deploy.md`, Updates). All of these are admins only, and the
mutations take the page's `sessionId` like the other admin ones.

- `api.updates.status` returns `{ channel, autoUpdate, version, updaterConfigured, request,
updater }`: the release channel (`stable` or `nightly`) and whether updates install on
  their own; the deployed commit (as `server.info`); whether the server has an updater at all;
  the admins' request the updater hasn't finished (`{ kind: 'check' | 'update', at }`); and
  the updater's last report, `{ seenAt, state, message?, startedAt?, current?, latest? }`.
  `state` is `idle`, `checking`, `updating` or `failed`; `current` is the commit the server
  runs; `latest` is the newest commit on `latest.channel` when it last looked
  (`checkedAt`), with `behind` (commits it has that the server doesn't) and `ahead` (the
  other way round). An update is available when `latest.channel` is the chosen channel,
  `behind > 0` and `ahead` is 0. The updater reports every ten minutes.
- `api.updates.setChannel({ channel })` and `api.updates.setAutoUpdate({ enabled })`.
  Changing the channel also asks the updater to check the new one.
- `api.updates.request({ kind })` asks the updater to check now or to update to the newest
  version; refused while an update runs, or where the server has no updater. A check doesn't
  replace a waiting update. `api.updates.cancelRequest({})` takes back one the updater hasn't
  started.

The updater calls `api.updates.poll` and `api.updates.report` with `UPDATER_SECRET`.

## Questions and follow-ups

1. **Done:** mentions and message requests come from the bridge host and are applied at
   ingest, and a new message wakes a snoozed chat. A read receipt from the person's phone
   recounts unread and mentions after it. The chat keeps how far the person has read
   (`readSortKey`, from `chats.markRead` or their own receipt, only ever forward), so a
   message that arrives late but sorts before it isn't counted unread, and an older receipt
   doesn't bring counts back. Someone else's receipt marks the person's own messages up to it
   `read` (at most 100 per receipt, newest first). Quarantined events are listed to admins
   (`quarantine.list`: host, sequence, type, reason and time only) and dismissed with
   `quarantine.dismiss({ ids })`.
2. **Network-side block and accept request.** There's no bridge command for either yet, so
   both are Trioditis-side. A `block` command needs a protocol change.
3. **Done:** contacts queries (Contacts): for a page's senders, and every contact for the
   address book. A list of a chat's members still needs a `members` event from the bridge host.
4. **Drafts** synced across devices are in the plan (a sealed `drafts` table) but not built.
5. **Media**: downloads are built (see Next); uploads, for sending a file, are planned.
6. **Changing the email** needs re-deriving `authPassword`; there's no email change yet.
7. **Done:** passkey PRF unlock. Adding a passkey makes its backup when the authenticator
   gives a PRF output, and signing in with one unlocks the key in the same touch (Passkeys).
8. **Label filter order**: a label view is in labelling order, not recency. Sorting it by
   recency needs a per-label recency index.

## Next: after Phase 0

The UI asked for these. They come in this order, on `api/client-next`, each with its
backend tests; the ones that need the bridge host change the protocol in the same pull
request. Until one lands, the UI keeps the control disabled or shows the fallback named
here.

1. **Server info (built).** `api.server.info` (a query, no sign-in needed) returns
   `{ demo, invitations, version }`: `demo` is whether demo data loads here (`TRIODITIS_DEMO=1` and
   no `TRIODITIS_NETWORKS`, as `demo.seedForMe` needs), and `invitations` whether admins
   can invite people here (false wherever `TRIODITIS_DEMO=1`). The client hides invite controls, and shows demo-only ones, from it instead
   of waiting for a mutation's error. The installed networks stay in `api.networks.list`.
   `version` is the commit the installer deployed (`TRIODITIS_VERSION`), or null where none
   was set (`pnpm dev`, previews); an open page compares it with its own build's to pick up
   an update (`docs/deploy.md`, Updating live).
2. **Contacts for senders (built).** `api.contacts.get({ network, ghostIds })`, at most 100 IDs,
   returns `{ ghostId, sealedProfile }[]` for those the person has (open with kind
   `contact`, object ID `ghostId`; plaintext is `ContactPlaintext`). The client collects
   the `ghostId`s on a page of messages and asks once per page. A list of a chat's members
   needs a new `members` event from the bridge host, so it comes later. Fallback: no sender
   name; a sender's messages run together as their own bubbles.
3. **Last-message preview (built).** Chat rows have `lastMessage`, the newest message's own
   envelope (kind `message`, its `objectId`), up to 4 KiB: see The list, The last message. It
   replaced the `sealedPreview` planned here, so nothing new is sealed for it.
4. **New chat (built).** See New chats.
5. **Media.** Files only ever leave the bridge host as ciphertext; the key and nonce stay in the
   sealed message (see `sealing.md`, Media).
   - **Download (built):** the bridge host keeps each incoming file encrypted in its media
     store, and the client fetches it from the gateway on the app's own origin:
     `GET /media/<mediaId>` with `Authorization: Bearer <token>`, which Caddy forwards to the
     gateway's public listener. The token comes from `api.media.access({ network })`
     (`{ token, expiresAt }`, good for an hour; ask again before it runs out, or after a
     `401`): it is signed with `GATEWAY_SECRET` and names the person and the network's bridge
     hosts, and the gateway asks those hosts for the file (bridge-protocol.md, Media), each of
     which gives a person only their own. The answer is the ciphertext as
     `application/octet-stream` with `no-store`, so no cache answers in place of the gateway's
     checks; a `404` means no host has it for this person, `502` a host failed, `503` too many
     files at once (retry after a second). The client decrypts it with
     `decryptMedia(ciphertext, key, nonce, userId, mediaId)` from `@trioditis/crypto` and keeps
     it only in memory: it shows pictures, video and sound (and SVG is not a picture here) from
     `data:` URLs, never a Blob, which the browser may page to disk. A file becomes a Blob only
     when the person saves it, and then as `application/octet-stream`, so it never opens as a
     page on the app's origin. A chat's or a contact's `avatar` is fetched the same way.
   - The desktop app shows pictures up to 25 MiB in place (trying again a few times when one
     fails), holding only those within about two screens of the view and letting the rest go;
     it plays video and sound up to 50 MiB when asked, and saves other files. A picture with no
     caption has its file name as its `body`, which is not shown as a caption.
   - **Upload (planned):** `api.media.uploadUrl({ chatId, size, mime })` (at most 100 MiB) gives a
     URL for the encrypted file; the send's attachment names the returned `mediaId`, and
     the bridge host fetches it through the gateway and decrypts it with the key in the
     outbound plaintext. Unsent uploads are deleted after a day.
   - Fallback until uploads land: the composer can't attach a file. A file that can't be
     fetched shows its name and size, with a way to try again.

import {
  fromBase64Url,
  passkeyKey,
  passkeyPrfSalt,
  ready,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
} from '@trioditis/crypto'
import type { KeyPair } from '@trioditis/crypto'
import { asSession, authClient } from './auth-client.ts'

/*
 * Passkeys sign in, and, where the authenticator offers WebAuthn's PRF extension, also unlock the
 * identity key: the PRF output becomes a wrapping key (packages/crypto `passkeyKey`), and the
 * server keeps the key wrapped by it as a passkey backup. The output itself never leaves this
 * device. See docs/architecture/client-api.md, Passkeys.
 */

/** A passkey backup of the identity key, as `keys.identity` lists it. */
export interface PasskeyBackup {
  kid: string
  kind: 'passkey' | 'password' | 'recovery'
  nonce: string
  ct: string
  credentialId?: string
  prfSalt?: string
  revision: number
}

/** A PRF output from one passkey: the secret its backup is wrapped with. */
export interface PrfResult {
  credentialId: string
  output: Uint8Array
}

/** A passkey answered, but its authenticator (or this browser) gave no PRF output. */
export class NoPrf extends Error {
  constructor() {
    super('That passkey can’t unlock your key: its authenticator, or this browser, doesn’t offer what it needs.')
  }
}

/** The person closed the passkey prompt, or it timed out. */
export class PasskeyCancelled extends Error {
  constructor() {
    super('The passkey prompt was closed before it finished.')
  }
}

/** The PRF input as WebAuthn takes it, from the one every backup is made with. */
async function prfInput(): Promise<Uint8Array<ArrayBuffer>> {
  await ready()
  return new Uint8Array(passkeyPrfSalt())
}

/**
 * Asks for the PRF output for `first`, as Better Auth's passkey calls take extensions. They pass
 * them to WebAuthn as they are; their type (from SimpleWebAuthn) just doesn't list PRF yet.
 */
const prfExtension = (first: Uint8Array<ArrayBuffer>) =>
  ({ prf: { eval: { first } } }) as AuthenticationExtensionsClientInputs as NonNullable<
    Parameters<typeof authClient.signIn.passkey>[0]
  >['extensions']

/** The first PRF result a ceremony gave, if it gave one of the right size. */
function prfOutputOf(results: AuthenticationExtensionsClientOutputs | undefined): Uint8Array | null {
  const first = results?.prf?.results?.first
  if (!first) return null
  const bytes = new Uint8Array(
    ArrayBuffer.isView(first) ? first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) : first,
  )
  return bytes.length === 32 ? bytes : null
}

/** What a Better Auth call returned as an error, thrown, keeping its `code` and `status`. */
function failure(error: { code?: string; message?: string; status?: number }, fallback: string): Error {
  return Object.assign(new Error(error.message || fallback), { code: error.code, status: error.status })
}

/**
 * Signs in with a passkey, asking it for its PRF output in the same touch. Answers who signed
 * in, and the output, if the passkey gave one, for unlocking straight after (holdPrf).
 */
export async function signInWithPasskey(): Promise<
  { error: { code?: string; message?: string; status?: number } } | { userId: string; prf: PrfResult | null }
> {
  const first = await prfInput()
  const result = await authClient.signIn.passkey({ extensions: prfExtension(first), returnWebAuthnResponse: true })
  if (!result || result.error || !result.data) return { error: result?.error ?? {} }
  const user = (result.data as { user?: { id?: string } }).user
  if (!user?.id) return { error: {} }
  const webauthn = (
    result as {
      webauthn?: { response: { id: string }; clientExtensionResults?: AuthenticationExtensionsClientOutputs }
    }
  ).webauthn
  const output = prfOutputOf(webauthn?.clientExtensionResults)
  return { userId: user.id, prf: output && webauthn ? { credentialId: webauthn.response.id, output } : null }
}

/**
 * Adds a passkey to the account, as the page's session, asking it for its PRF output as it's
 * made. Some authenticators give it only when the passkey is next used (evaluatePasskeys), so
 * `prf` may be null even for one that can unlock. Throws what Better Auth refused with.
 */
export async function addPasskey(sessionId: string): Promise<{ credentialId: string; prf: Uint8Array | null }> {
  const first = await prfInput()
  const result = await asSession(sessionId, () =>
    authClient.passkey.addPasskey({ extensions: prfExtension(first), returnWebAuthnResponse: true }),
  )
  if (!result || result.error || !result.data) {
    const error: { code?: string; message?: string; status?: number } = result?.error ?? {}
    if (error.code === 'ERROR_CEREMONY_ABORTED') throw new PasskeyCancelled()
    throw failure(error, 'The passkey couldn’t be added.')
  }
  const webauthn = (
    result as {
      webauthn?: { response: { id: string }; clientExtensionResults?: AuthenticationExtensionsClientOutputs }
    }
  ).webauthn
  const credentialId = webauthn?.response.id ?? (result.data as { credentialID?: string }).credentialID
  if (!credentialId) throw new Error('The passkey was added, but the browser didn’t say which it was.')
  return { credentialId, prf: prfOutputOf(webauthn?.clientExtensionResults) }
}

/**
 * Asks one of `backups`' passkeys for its PRF output, for its own input (`prfSalt`). Nothing is
 * sent to the server: the output only opens the backup, which the server can't check, so this
 * ceremony's signature is never needed. Throws PasskeyCancelled or NoPrf.
 */
export async function evaluatePasskeys(backups: { credentialId: string; prfSalt: string }[]): Promise<PrfResult> {
  if (backups.length === 0) throw new NoPrf()
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) {
    throw new Error('This browser doesn’t support passkeys.')
  }
  const evalByCredential: Record<string, AuthenticationExtensionsPRFValues> = {}
  for (const backup of backups)
    evalByCredential[backup.credentialId] = { first: new Uint8Array(fromBase64Url(backup.prfSalt)) }
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: backups.map((backup) => ({
          type: 'public-key' as const,
          id: new Uint8Array(fromBase64Url(backup.credentialId)),
        })),
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { evalByCredential } },
      },
    })
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
      throw new PasskeyCancelled()
    }
    throw e
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelled()
  const output = prfOutputOf(credential.getClientExtensionResults())
  if (!output) throw new NoPrf()
  return { credentialId: toBase64Url(new Uint8Array(credential.rawId)), output }
}

/**
 * A passkey backup of `keyPair` for `credentialId`, as `keys.putBackup` takes it (without the
 * proof and revision). It is opened again before it's returned, as every backup is: the server
 * can't check a wrap, and one that doesn't open would only seem to work.
 */
export async function passkeyBackup(userId: string, kid: string, keyPair: KeyPair, prf: PrfResult) {
  await ready()
  const context = { userId, kid, kind: 'passkey' } as const
  const wrappingKey = passkeyKey(prf.output)
  const wrap = wrapIdentityKey(keyPair.privateKey, wrappingKey, context)
  unwrapIdentityKey(wrap, wrappingKey, context, keyPair.publicKey)
  return {
    kind: 'passkey' as const,
    ...wrap,
    credentialId: prf.credentialId,
    prfSalt: toBase64Url(passkeyPrfSalt()),
  }
}

/** Opens `backup` with a PRF output from its passkey. Throws a SealError if it doesn't open. */
export async function openPasskeyBackup(
  backup: PasskeyBackup,
  prf: PrfResult,
  userId: string,
  publicKey: Uint8Array,
): Promise<KeyPair> {
  await ready()
  return unwrapIdentityKey(backup, passkeyKey(prf.output), { userId, kid: backup.kid, kind: 'passkey' }, publicKey)
}

// The PRF output from signing in with a passkey, held in memory for the moment it takes to
// unlock the identity key on the next screen, so the person touches their passkey once. Like the
// password held from signing in (pending-password.ts): taken once, only for the account it was
// given for, and never stored.
let pending: { prf: PrfResult; userId: string } | null = null

export function holdPrf(prf: PrfResult, userId: string) {
  pending = { prf, userId }
  setTimeout(() => {
    if (pending?.prf === prf) pending = null
  }, 60_000)
}

/** The PRF output held for `userId`; null if none, or if it was given for someone else. */
export function takePrf(userId: string): PrfResult | null {
  const value = pending?.userId === userId ? pending.prf : null
  pending = null
  return value
}

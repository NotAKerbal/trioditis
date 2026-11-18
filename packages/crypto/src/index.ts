// Sealing: how Trioditis stores content so the server can encrypt to a person but never
// decrypt what it stored. The format is specified in docs/architecture/sealing.md; the Go
// implementation in apps/bridge-host follows the same spec and is tested against
// testdata/vectors.json.

import sodium from 'libsodium-wrappers-sumo'

/** Resolves once libsodium has loaded. Call before anything else in this module. */
export async function ready(): Promise<void> {
  await sodium.ready
}

export const ENVELOPE_VERSION = 1

export type SealKind = 'message' | 'chat' | 'contact' | 'draft' | 'outbound' | 'media' | 'label'

/** The row a sealed object belongs to. Bound into the ciphertext as associated data. */
export interface SealContext {
  kind: SealKind
  ownerUserId: string
  objectId: string
}

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface Recipient {
  publicKey: Uint8Array
}

export interface EnvelopeKey {
  /** Key ID of the recipient's public key. */
  kid: string
  /** The content key, sealed to that recipient. */
  sk: string
}

export interface Envelope {
  v: typeof ENVELOPE_VERSION
  nonce: string
  ct: string
  keys: EnvelopeKey[]
}

export class SealError extends Error {
  override name = 'SealError'
}

const CONTENT_KEY_BYTES = 32
const NONCE_BYTES = 24
const KEY_ID_BYTES = 16

export function toBase64Url(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
}

export function fromBase64Url(text: string): Uint8Array {
  try {
    return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING)
  } catch {
    throw new SealError('Invalid base64url')
  }
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = sodium.crypto_box_keypair()
  return { publicKey, privateKey }
}

/** The first 16 bytes of BLAKE2b-256 of the public key, base64url. */
export function keyId(publicKey: Uint8Array): string {
  return toBase64Url(sodium.crypto_generichash(32, publicKey, null).subarray(0, KEY_ID_BYTES))
}

export function associatedData({ kind, ownerUserId, objectId }: SealContext): Uint8Array {
  if (!ownerUserId || !objectId) throw new SealError('A sealed object needs an owner and an ID')
  return sodium.from_string(`trioditis/v1/${kind}/${ownerUserId}/${objectId}`)
}

function sealContentKey(contentKey: Uint8Array, recipient: Recipient): EnvelopeKey {
  return { kid: keyId(recipient.publicKey), sk: toBase64Url(sodium.crypto_box_seal(contentKey, recipient.publicKey)) }
}

/** Encrypts `plaintext` for every recipient. The content key is discarded afterwards. */
export function seal(plaintext: Uint8Array, recipients: Recipient[], context: SealContext): Envelope {
  if (recipients.length === 0) throw new SealError('A sealed object needs at least one recipient')
  const contentKey = sodium.randombytes_buf(CONTENT_KEY_BYTES)
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  try {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      associatedData(context),
      null,
      nonce,
      contentKey,
    )
    return {
      v: ENVELOPE_VERSION,
      nonce: toBase64Url(nonce),
      ct: toBase64Url(ct),
      keys: dedupeRecipients(recipients).map((recipient) => sealContentKey(contentKey, recipient)),
    }
  } finally {
    sodium.memzero(contentKey)
  }
}

export function sealJson(value: unknown, recipients: Recipient[], context: SealContext): Envelope {
  return seal(sodium.from_string(JSON.stringify(value)), recipients, context)
}

function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>()
  return recipients.filter((recipient) => {
    const kid = keyId(recipient.publicKey)
    if (seen.has(kid)) return false
    seen.add(kid)
    return true
  })
}

function checkVersion(envelope: Envelope) {
  if (envelope.v !== ENVELOPE_VERSION) throw new SealError(`Unsupported envelope version ${String(envelope.v)}`)
}

/** Recovers the content key with `keyPair`, which must be one of the envelope's recipients. */
function openContentKey(envelope: Envelope, keyPair: KeyPair): Uint8Array {
  checkVersion(envelope)
  const kid = keyId(keyPair.publicKey)
  const entry = envelope.keys.find((key) => key.kid === kid)
  if (!entry) throw new SealError('This key is not a recipient of the envelope')
  try {
    return sodium.crypto_box_seal_open(fromBase64Url(entry.sk), keyPair.publicKey, keyPair.privateKey)
  } catch {
    throw new SealError('The content key could not be opened')
  }
}

function decryptContent(envelope: Envelope, contentKey: Uint8Array, context: SealContext): Uint8Array {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(envelope.ct),
      associatedData(context),
      fromBase64Url(envelope.nonce),
      contentKey,
    )
  } catch {
    throw new SealError('The envelope could not be decrypted for this object')
  }
}

export function open(envelope: Envelope, keyPair: KeyPair, context: SealContext): Uint8Array {
  const contentKey = openContentKey(envelope, keyPair)
  try {
    return decryptContent(envelope, contentKey, context)
  } finally {
    sodium.memzero(contentKey)
  }
}

export function openJson<T = unknown>(envelope: Envelope, keyPair: KeyPair, context: SealContext): T {
  return JSON.parse(sodium.to_string(open(envelope, keyPair, context))) as T
}

/**
 * Adds a recipient without re-encrypting the content, as granting an agent a chat's history
 * does. `keyPair` must already be a recipient. Checks the content key against the ciphertext
 * first, so a corrupt envelope is never re-shared.
 */
export function addRecipient(
  envelope: Envelope,
  keyPair: KeyPair,
  recipient: Recipient,
  context: SealContext,
): Envelope {
  const contentKey = openContentKey(envelope, keyPair)
  try {
    decryptContent(envelope, contentKey, context)
    const kid = keyId(recipient.publicKey)
    if (envelope.keys.some((key) => key.kid === kid)) return envelope
    return { ...envelope, keys: [...envelope.keys, sealContentKey(contentKey, recipient)] }
  } finally {
    sodium.memzero(contentKey)
  }
}

/** Removes a recipient, as revoking an agent's grant does. The last recipient can't be removed. */
export function removeRecipient(envelope: Envelope, kid: string): Envelope {
  checkVersion(envelope)
  const keys = envelope.keys.filter((key) => key.kid !== kid)
  if (keys.length === 0) throw new SealError("The envelope's last recipient can't be removed")
  return { ...envelope, keys }
}

export interface EncryptedMedia {
  ciphertext: Uint8Array
  /** Base64url. Goes inside the sealed message plaintext, never next to the file. */
  key: string
  nonce: string
}

/** Encrypts a file with its own key. Associated data binds it to its owner and media ID. */
export function encryptMedia(bytes: Uint8Array, ownerUserId: string, mediaId: string): EncryptedMedia {
  const key = sodium.randombytes_buf(CONTENT_KEY_BYTES)
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  const ad = associatedData({ kind: 'media', ownerUserId, objectId: mediaId })
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, ad, null, nonce, key)
  return { ciphertext, key: toBase64Url(key), nonce: toBase64Url(nonce) }
}

export function decryptMedia(
  ciphertext: Uint8Array,
  key: string,
  nonce: string,
  ownerUserId: string,
  mediaId: string,
): Uint8Array {
  const ad = associatedData({ kind: 'media', ownerUserId, objectId: mediaId })
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      ad,
      fromBase64Url(nonce),
      fromBase64Url(key),
    )
  } catch {
    throw new SealError('The file could not be decrypted')
  }
}

// Identity key backups: how a new device gets the person's identity private key. The key is
// only ever stored wrapped, by a key derived from their password, by their recovery key, or
// (later) by a passkey. See docs/architecture/client-api.md, Keys.

export type KeyBackupKind = 'password' | 'recovery' | 'passkey'

/** A wrapped identity private key: XChaCha20-Poly1305, base64url. */
export interface WrappedKey {
  nonce: string
  ct: string
}

/** How a password becomes a wrapping key. Stored with the backup; none of it is secret. */
export interface PasswordParams {
  alg: 'argon2id13'
  salt: string
  opslimit: number
  memlimit: number
}

export interface KeyBackupContext {
  userId: string
  /** Key ID of the identity public key the wrapped private key belongs to. */
  kid: string
  kind: KeyBackupKind
}

const WRAPPING_KEY_BYTES = 32
/** Argon2id at 3 passes over 64 MiB: about a second in a browser, and costly to guess at. */
const PASSWORD_OPSLIMIT = 3
const PASSWORD_MEMLIMIT = 64 * 1024 * 1024
/** The weakest settings a key backup may use. The server refuses anything below them. */
export const MIN_PASSWORD_PARAMS = { opslimit: PASSWORD_OPSLIMIT, memlimit: PASSWORD_MEMLIMIT } as const

function backupAssociatedData({ userId, kid, kind }: KeyBackupContext): Uint8Array {
  if (!userId || !kid) throw new SealError('A key backup needs an owner and a key ID')
  return sodium.from_string(`trioditis/v1/keybackup/${userId}/${kid}/${kind}`)
}

export function newPasswordParams(): PasswordParams {
  return {
    alg: 'argon2id13',
    salt: toBase64Url(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)),
    opslimit: PASSWORD_OPSLIMIT,
    memlimit: PASSWORD_MEMLIMIT,
  }
}

/** The wrapping key a password gives under `params`. */
export function passwordKey(password: string, params: PasswordParams): Uint8Array {
  if (params.alg !== 'argon2id13') throw new SealError(`Unsupported password algorithm ${String(params.alg)}`)
  if (!password) throw new SealError('A password is required')
  return sodium.crypto_pwhash(
    WRAPPING_KEY_BYTES,
    password.normalize('NFKC'),
    fromBase64Url(params.salt),
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
}

export function wrapIdentityKey(
  privateKey: Uint8Array,
  wrappingKey: Uint8Array,
  context: KeyBackupContext,
): WrappedKey {
  if (wrappingKey.length !== WRAPPING_KEY_BYTES) throw new SealError('A wrapping key is 32 bytes')
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privateKey,
    backupAssociatedData(context),
    null,
    nonce,
    wrappingKey,
  )
  return { nonce: toBase64Url(nonce), ct: toBase64Url(ct) }
}

/**
 * Unwraps an identity private key and checks it belongs to `publicKey`. A wrong password or
 * recovery key, or a backup for another key or person, throws.
 */
export function unwrapIdentityKey(
  wrapped: WrappedKey,
  wrappingKey: Uint8Array,
  context: KeyBackupContext,
  publicKey: Uint8Array,
): KeyPair {
  let privateKey: Uint8Array
  try {
    privateKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64Url(wrapped.ct),
      backupAssociatedData(context),
      fromBase64Url(wrapped.nonce),
      wrappingKey,
    )
  } catch {
    throw new SealError('That password or recovery key doesn’t open this backup')
  }
  const pair = keyPairFromPrivateKey(privateKey)
  if (!sodium.memcmp(pair.publicKey, publicKey)) throw new SealError('The backup holds a different key')
  return pair
}

/**
 * A password backup of the identity key, exactly as `keys.setup` stores it: fresh Argon2id
 * settings and the wrap. For scripts that seed an account (previews, the nightly) as well as
 * the first-device flow.
 */
export function makeKeyBackup(privateKey: Uint8Array, password: string, userId: string) {
  const { publicKey } = keyPairFromPrivateKey(privateKey)
  const kid = keyId(publicKey)
  const params = newPasswordParams()
  const wrap = wrapIdentityKey(privateKey, passwordKey(password, params), { userId, kid, kind: 'password' })
  return { publicKey: toBase64Url(publicKey), kid, password: { ...wrap, params } }
}

/**
 * What a person's password becomes before it goes to the sign-in server, so the server never
 * sees the password itself and can't unwrap the key backup with it. It is Argon2id over the
 * password (NFKC-normalised), salted by the person's email, then BLAKE2b-256, as base64url.
 * Used for sign-up, sign-in and changing the password; the key backup's wrapping key is a
 * separate Argon2id with its own random salt (`passwordKey`).
 *
 * The salt is the email, so changing the email means signing in with the old one, deriving
 * again with the new one, and changing the password to that.
 */
export function authPassword(password: string, email: string): string {
  if (!password) throw new SealError('A password is required')
  const salt = sodium.crypto_generichash(
    sodium.crypto_pwhash_SALTBYTES,
    sodium.from_string(`trioditis/auth/v1/${email.trim().toLowerCase()}`),
    null,
  )
  const stretched = sodium.crypto_pwhash(
    32,
    password.normalize('NFKC'),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
  return toBase64Url(sodium.crypto_generichash(32, stretched, null))
}

/** Opens a sealed box made for `keyPair` (libsodium `crypto_box_seal`), such as a key challenge. */
export function openSealedBox(sealed: Uint8Array, keyPair: KeyPair): Uint8Array {
  try {
    return sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.privateKey)
  } catch {
    throw new SealError('That wasn’t sealed to this key')
  }
}

export function keyPairFromPrivateKey(privateKey: Uint8Array): KeyPair {
  return { publicKey: sodium.crypto_scalarmult_base(privateKey), privateKey }
}

// Recovery keys: 32 random bytes plus a 2-byte checksum, written in Crockford base32 (no I, L,
// O or U, so they can't be misread) in groups of five. Typing it back is forgiving about case,
// spaces and dashes, and the checksum catches a mistyped character.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_KEY_BYTES = 32
const CHECKSUM_BYTES = 2

export interface RecoveryKey {
  /** The wrapping key. */
  bytes: Uint8Array
  /** What the person writes down. */
  text: string
}

export function generateRecoveryKey(): RecoveryKey {
  const bytes = sodium.randombytes_buf(RECOVERY_KEY_BYTES)
  return { bytes, text: encodeRecoveryKey(bytes) }
}

function checksum(bytes: Uint8Array) {
  return sodium.crypto_generichash(CHECKSUM_BYTES, bytes, null)
}

export function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new SealError('A recovery key is 32 bytes')
  const all = new Uint8Array([...bytes, ...checksum(bytes)])
  let bits = 0
  let value = 0
  let text = ''
  for (const byte of all) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      text += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) text += CROCKFORD[(value << (5 - bits)) & 31]
  return text.match(/.{1,5}/g)!.join('-')
}

export function decodeRecoveryKey(text: string): Uint8Array {
  const cleaned = text.toUpperCase().replace(/[\s-]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of cleaned) {
    const index = CROCKFORD.indexOf(char)
    if (index < 0) throw new SealError('That isn’t a recovery key')
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  // One spelling per key: the bits left over in the last character must be zero.
  if (out.length !== RECOVERY_KEY_BYTES + CHECKSUM_BYTES || (value & ((1 << bits) - 1)) !== 0) {
    throw new SealError('That isn’t a recovery key')
  }
  const bytes = Uint8Array.from(out.slice(0, RECOVERY_KEY_BYTES))
  if (!sodium.memcmp(checksum(bytes), Uint8Array.from(out.slice(RECOVERY_KEY_BYTES)))) {
    throw new SealError('That recovery key has a typo')
  }
  return bytes
}

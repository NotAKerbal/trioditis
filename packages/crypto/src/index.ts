// Sealing: how Trioditis stores content so the server can encrypt to a person but never
// decrypt what it stored. The format is specified in docs/architecture/sealing.md; the Go
// implementation in apps/bridge-host follows the same spec and is tested against
// testdata/vectors.json.

import sodium from 'libsodium-wrappers'

/** Resolves once libsodium has loaded. Call before anything else in this module. */
export async function ready(): Promise<void> {
  await sodium.ready
}

export const ENVELOPE_VERSION = 1

export type SealKind = 'message' | 'chat' | 'contact' | 'draft' | 'outbound' | 'media'

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

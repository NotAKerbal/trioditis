import { blake2b } from '@noble/hashes/blake2.js'
import type { Infer } from 'convex/values'
import type { envelope } from '../validators'

// Format checks for sealed data at the backend's boundaries. They can't prove a ciphertext is
// authentic (only a recipient can), but they keep a plaintext string or a malformed key from
// being stored where an envelope or a key belongs. See docs/architecture/sealing.md.

const BASE64URL = /^[A-Za-z0-9_-]*$/
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** The number of bytes `text` decodes to as unpadded base64url, or null if it isn't that. */
export function decodedLength(text: string): number | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null
  const bytes = Math.floor((text.length * 6) / 8)
  // Canonical encoding: the unused low bits of the last character are zero, so one value
  // has one spelling.
  const unusedBits = text.length * 6 - bytes * 8
  if (unusedBits > 0) {
    const last = ALPHABET.indexOf(text[text.length - 1]!)
    if (last & ((1 << unusedBits) - 1)) return null
  }
  return bytes
}

export function decode(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** A canonical base64url X25519 public key. */
export function isPublicKey(text: string): boolean {
  return decodedLength(text) === 32
}

/** The key ID of a public key: the first 16 bytes of BLAKE2b-256, base64url. */
export function keyIdOf(publicKey: string): string {
  return encode(blake2b(decode(publicKey), { dkLen: 32 }).subarray(0, 16))
}

const NONCE_BYTES = 24
const TAG_BYTES = 16
const KEY_ID_BYTES = 16
/** A 32-byte content key in a sealed box: 32-byte ephemeral key, 16-byte tag. */
const SEALED_KEY_BYTES = 32 + 32 + 16
const MAX_RECIPIENTS = 8

/**
 * The most a client may seal into one send or login input. It keeps every outbox read small,
 * so a claim's transaction stays well inside Convex's read limit. Files travel separately.
 */
export const MAX_CLIENT_SEALED_BYTES = 64 * 1024

/**
 * Whether `value` is formatted as an envelope: canonical base64url, the right lengths, one to
 * `MAX_RECIPIENTS` key entries. A format check only: it can't tell ciphertext from anything
 * else encoded to look like it. That rests on whoever sealed it, and on the recipient opening it.
 */
export function isEnvelope(value: Infer<typeof envelope>, maxBytes = Infinity): boolean {
  if (value.keys.length === 0 || value.keys.length > MAX_RECIPIENTS) return false
  if (decodedLength(value.nonce) !== NONCE_BYTES) return false
  const ct = decodedLength(value.ct)
  if (ct === null || ct < TAG_BYTES || ct > maxBytes) return false
  return value.keys.every(
    (key) => decodedLength(key.kid) === KEY_ID_BYTES && decodedLength(key.sk) === SEALED_KEY_BYTES,
  )
}

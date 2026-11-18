import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hsalsa, secretbox } from '@noble/ciphers/salsa.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import type { Infer } from 'convex/values'
import type { envelope } from '../validators'
import { decode, encode, keyIdOf } from './envelope'

// Sealing on the server, for the few things the server itself seals to a person: a key
// challenge only their device can open, and the demo fixtures. Pure JavaScript, so it runs in
// Convex's runtime; it produces exactly what packages/crypto (libsodium) does, as the tests
// check by opening its output there. See docs/architecture/sealing.md.

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

function words(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true))
}

function bytes(input: Uint32Array) {
  const out = new Uint8Array(input.length * 4)
  const view = new DataView(out.buffer)
  input.forEach((word, i) => view.setUint32(i * 4, word, true))
  return out
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** libsodium's `crypto_box_seal`: an anonymous sealed box to `publicKey`. */
export function sealBox(message: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const ephemeral = x25519.keygen()
  const shared = x25519.getSharedSecret(ephemeral.secretKey, publicKey)
  // crypto_box_beforenm: HSalsa20 over the shared point with a zero nonce.
  const key = new Uint32Array(8)
  hsalsa(SIGMA, words(shared), new Uint32Array(4), key)
  const nonce = blake2b(concat(ephemeral.publicKey, publicKey), { dkLen: 24 })
  return concat(ephemeral.publicKey, secretbox(bytes(key), nonce).seal(message))
}

/** An envelope (sealing.md, Envelope v1) of `value` as JSON, for the given recipients. */
export function sealJson(
  value: unknown,
  recipientPublicKeys: string[],
  context: { kind: string; ownerUserId: string; objectId: string },
): Infer<typeof envelope> {
  const contentKey = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const ad = new TextEncoder().encode(`trioditis/v1/${context.kind}/${context.ownerUserId}/${context.objectId}`)
  const ct = xchacha20poly1305(contentKey, nonce, ad).encrypt(new TextEncoder().encode(JSON.stringify(value)))
  const envelopeOut = {
    v: 1 as const,
    nonce: encode(nonce),
    ct: encode(ct),
    keys: recipientPublicKeys.map((publicKey) => ({
      kid: keyIdOf(publicKey),
      sk: encode(sealBox(contentKey, decode(publicKey))),
    })),
  }
  contentKey.fill(0)
  return envelopeOut
}

import { api } from '@trioditis/backend/api'
import { fromBase64Url, openSealedBox, toBase64Url, type KeyPair } from '@trioditis/crypto'
import { convex } from './convex.ts'

/**
 * Proves this device holds the identity private key, for changing a key backup: the server seals
 * a one-time challenge to the public key and only the private key opens it. Works once, within
 * five minutes. See docs/architecture/client-api.md, Proving the device has the key.
 */
export async function proveKey(keyPair: KeyPair): Promise<string> {
  const { sealed } = await convex.mutation(api.keys.challenge, {})
  return toBase64Url(openSealedBox(fromBase64Url(sealed), keyPair))
}

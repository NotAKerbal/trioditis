import { api } from '@trioditis/backend/api'
import { fromBase64Url, openSealedBox, toBase64Url, type KeyPair } from '@trioditis/crypto'
import { convex } from './convex.ts'

/**
 * Proves this device holds the identity private key, for setting the key up and for changing a
 * key backup: the server seals a one-time challenge to the public key and only the private key
 * opens it. The challenge names this key, so it works before the account has one (first-device
 * setup) and, once it has one, only if it's this one. Works once, before it expires (five
 * minutes), so get it just before the call it's for. See docs/architecture/client-api.md,
 * Proving the device has the key. `sessionId` is the session the page opened with: the server
 * refuses it for any other (sessionChanged, lib/errors.ts).
 */
export async function proveKey(keyPair: KeyPair, sessionId: string): Promise<string> {
  const { sealed } = await convex.mutation(api.keys.challenge, {
    publicKey: toBase64Url(keyPair.publicKey),
    sessionId,
  })
  return toBase64Url(openSealedBox(fromBase64Url(sealed), keyPair))
}

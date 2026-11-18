import { keyId, fromBase64Url } from '@trioditis/crypto'
import type { RecipientKeys } from '@trioditis/core/bridge-protocol'
import type { Backend } from './backend.ts'
import type { Reply } from './events.ts'

// GET /v1/keys/:userId: the public keys the bridge host seals a person's objects to.

export async function handleKeys(backend: Backend, agentAccessPublicKey: string, userId: string): Promise<Reply> {
  const keys = await backend.recipientKeys({ userId })
  // Nobody can be sealed to without an identity key; the bridge host refuses their logins.
  if (!keys) return { status: 409, body: { error: 'No identity key yet' } }
  const body: RecipientKeys = {
    identity: { kid: keyId(fromBase64Url(keys.identityPublicKey)), publicKey: keys.identityPublicKey },
    agentAccess: { kid: keyId(fromBase64Url(agentAccessPublicKey)), publicKey: agentAccessPublicKey },
    agentGrantedPortals: keys.agentGrantedPortals,
  }
  return { status: 200, body }
}

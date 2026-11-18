import { fromBase64Url, openJson, sealJson, type Envelope, type KeyPair, type SealKind } from '@trioditis/crypto'

// Opening and sealing content. The formats are docs/architecture/sealing.md; the field names
// match the bridge host's protocol types.

export interface MediaRef {
  mediaId: string
  mime: string
  size: number
  name?: string
  key: string
  nonce: string
  width?: number
  height?: number
  durationMs?: number
}

export interface ChatMeta {
  name?: string
  topic?: string
  avatar?: MediaRef
  avatarUnchanged?: boolean
}

export interface MessageBody {
  type: 'text' | 'notice' | 'emote' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location'
  body: string
  html?: string
  attachments?: MediaRef[]
  mentions?: string[]
}

/** Opens an envelope, or returns null when this device can't (a missing or other key, or tampering). */
export function tryOpen<T>(envelope: Envelope | undefined, keyPair: KeyPair, kind: SealKind, ownerUserId: string, objectId: string): T | null {
  if (!envelope) return null
  try {
    return openJson<T>(envelope, keyPair, { kind, ownerUserId, objectId })
  } catch {
    return null
  }
}

/**
 * Seals a text message twice, as messages.send takes it: for the bridge host (kind `outbound`)
 * and as the person's own stored copy (kind `message`), both under `clientMessageId`.
 */
export function sealSend(text: string, clientMessageId: string, ownerUserId: string, identityPublicKey: Uint8Array, bridgePublicKey: string) {
  const body: MessageBody = { type: 'text', body: text }
  const forBridge = sealJson(body, [{ publicKey: fromBase64Url(bridgePublicKey) }], { kind: 'outbound', ownerUserId, objectId: clientMessageId })
  const copy = sealJson(body, [{ publicKey: identityPublicKey }], { kind: 'message', ownerUserId, objectId: clientMessageId })
  return { forBridge, copy }
}

/** Seals what the person typed into a login step, to the bridge key only. */
export function sealLoginInput(input: Record<string, string>, loginSessionId: string, stepId: string, ownerUserId: string, bridgePublicKey: string) {
  return sealJson({ input }, [{ publicKey: fromBase64Url(bridgePublicKey) }], { kind: 'outbound', ownerUserId, objectId: `${loginSessionId}/${stepId}` })
}

/** A new client message ID: 18 random bytes as 24 base64url characters, as messages.send requires. */
export function newClientMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

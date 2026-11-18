import type { ChatPlaintext, MessagePlaintext } from '@trioditis/core'
import { fromBase64Url, openJson, sealJson, type Envelope, type KeyPair, type SealKind } from '@trioditis/crypto'

// Opening and sealing content, per docs/architecture/sealing.md and client-api.md.

export type { ChatPlaintext, MessagePlaintext }

/** A label's sealed plaintext. `color` names a label token (`--label-<color>`), never a value. */
export interface LabelPlaintext {
  name: string
  color: LabelColor
}
export const LABEL_COLORS = ['pink', 'blue', 'green', 'amber', 'violet', 'slate'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

/** Opens an envelope, or returns null when this device can't (another key, or tampering). */
export function tryOpen<T>(
  envelope: Envelope | null | undefined,
  keyPair: KeyPair,
  kind: SealKind,
  ownerUserId: string,
  objectId: string,
): T | null {
  if (!envelope) return null
  try {
    return openJson<T>(envelope, keyPair, { kind, ownerUserId, objectId })
  } catch {
    return null
  }
}

/**
 * Seals a text message twice, as messages.send and scheduled.create take it: for the bridge
 * host (kind `outbound`) and as the person's own stored copy (kind `message`).
 */
export function sealText(
  text: string,
  clientMessageId: string,
  ownerUserId: string,
  identityPublicKey: Uint8Array,
  bridgePublicKey: string,
) {
  const body: MessagePlaintext = { type: 'text', body: text }
  const forBridge = sealJson(body, [{ publicKey: fromBase64Url(bridgePublicKey) }], {
    kind: 'outbound',
    ownerUserId,
    objectId: clientMessageId,
  })
  const copy = sealJson(body, [{ publicKey: identityPublicKey }], {
    kind: 'message',
    ownerUserId,
    objectId: clientMessageId,
  })
  return { forBridge, copy }
}

/** Seals what the person typed into a login step, to the bridge key only: it's a credential. */
export function sealLoginInput(
  input: Record<string, string>,
  loginSessionId: string,
  stepId: string,
  ownerUserId: string,
  bridgePublicKey: string,
) {
  return sealJson({ input }, [{ publicKey: fromBase64Url(bridgePublicKey) }], {
    kind: 'outbound',
    ownerUserId,
    objectId: `${loginSessionId}/${stepId}`,
  })
}

export function sealLabel(label: LabelPlaintext, labelKey: string, ownerUserId: string, identityPublicKey: Uint8Array) {
  return sealJson(label, [{ publicKey: identityPublicKey }], { kind: 'label', ownerUserId, objectId: labelKey })
}

/** A new client message ID (or label key): 32 hex characters, within the 16–64 the backend accepts. */
export function newClientId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

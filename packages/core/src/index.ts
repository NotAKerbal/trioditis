// Types shared by every Trioditis package: networks, delivery states and the sealed message
// plaintext. The bridge host ↔ gateway wire types are in ./bridge-protocol.ts.

export const NETWORKS = [
  'whatsapp',
  'signal',
  'gmessages',
  'telegram',
  'meta',
  'instagram',
  'discord',
  'slack',
  'groupme',
  'gvoice',
  'linkedin',
  'twitter',
  'bluesky',
  'fake',
] as const
export type Network = (typeof NETWORKS)[number]

export type Maturity = 'stable' | 'beta' | 'experimental'

/** Where a message the person sent is. See docs/PLAN.md, Reliability. */
export const DELIVERY_STATES = [
  'queued',
  'claimed',
  'submitted',
  'sent',
  'delivered',
  'read',
  'failed',
  'unknown',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** States a send can't leave on its own. `unknown` waits for the person to choose. */
export const TERMINAL_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set(['delivered', 'read', 'failed', 'unknown'])

export type ChatKind = 'dm' | 'group' | 'channel' | 'space' | 'agent'

export type MessageType = 'text' | 'notice' | 'emote' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location'

export interface Attachment {
  mediaId: string
  mime: string
  size: number
  name?: string
  /** The file's own key and nonce, base64url. Only ever inside a sealed message. */
  key: string
  nonce: string
  width?: number
  height?: number
  durationMs?: number
}

/** A message's sealed content. See docs/architecture/sealing.md, Message plaintext. */
export interface MessagePlaintext {
  type: MessageType
  body: string
  html?: string
  attachments?: Attachment[]
  mentions?: string[]
  /** Cut short to fit the sealed size limit: `html` dropped, `body` possibly incomplete. */
  truncated?: boolean
  [extra: string]: unknown
}

export interface ChatPlaintext {
  name?: string
  topic?: string
  /** The avatar file, with its key and nonce. */
  avatar?: Attachment
  /**
   * The avatar is unchanged but couldn't be included this time: keep the one you have
   * rather than clearing it.
   */
  avatarUnchanged?: boolean
  [extra: string]: unknown
}

export interface ContactPlaintext {
  name?: string
  handle?: string
  /** The avatar file, with its key and nonce. */
  avatar?: Attachment
  /**
   * The avatar is unchanged but couldn't be included this time: keep the one you have
   * rather than clearing it.
   */
  avatarUnchanged?: boolean
  [extra: string]: unknown
}

export * from './client.ts'

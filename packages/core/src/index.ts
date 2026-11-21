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
  /**
   * The file arrived but the bridge host couldn't store it: `mediaId`, `key` and `nonce` are
   * empty and there is nothing to fetch. The rest says what the file was.
   */
  failed?: boolean
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
  /**
   * In a direct chat, the `ghostId` of the person on the other side: whose contact profile and
   * People card the chat is with. Missing in a group, and in a direct chat the bridge host
   * hasn't described since it began saying.
   */
  dmGhostId?: string
  [extra: string]: unknown
}

/**
 * A network account's own metadata, from its `loginState` events: kind `account`, object ID its
 * `loginId`, sealed to the owner only. `hint` tells it apart from their other accounts on the
 * network (its phone number or username); the login ID can't, being a keyed hash.
 */
export interface AccountPlaintext {
  hint?: string
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

/**
 * What one of the person's own logins knows a contact by, as URIs: `tel:+15551234567`,
 * `mailto:a@b.c`, `telegram:alice`. Sealed apart from the profile, since what each login can
 * see of a contact differs.
 */
export interface ContactIdentifiersPlaintext {
  identifiers: string[]
}

export * from './client.ts'
export * from './people.ts'
export * from './vcard.ts'

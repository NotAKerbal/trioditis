// What the desktop/web client works with: network capabilities, chat list rows, bridge health
// and preferences. docs/architecture/client-api.md describes the functions that return them.

import type { Envelope } from '@trioditis/crypto'
import type { ChatKind, Maturity, Network } from './index.ts'
import type { ErrorCode, LoginState } from './bridge-protocol.ts'

/** How a person can connect an account on a network. */
export interface LoginFlow {
  /** Passed to `logins.start` as `flowId`. */
  id: string
  /** What the stepper shows first: a QR code to scan, a code to type on the phone, cookies to paste, or a form. */
  kind: 'qr' | 'phone' | 'cookies' | 'form'
  name: string
}

export interface NetworkInfo {
  network: Network
  name: string
  maturity: Maturity
  flows: LoginFlow[]
  /** Connecting it can get the account banned under the network's terms (cookie or token logins). */
  termsRisk: boolean
}

/** What each network offers. Mirrors the bridge host's connectors; see docs/PLAN.md, Networks. */
export const NETWORK_INFO: Record<Network, NetworkInfo> = {
  whatsapp: {
    network: 'whatsapp',
    name: 'WhatsApp',
    maturity: 'stable',
    flows: [
      { id: 'qr', kind: 'qr', name: 'Scan a QR code' },
      { id: 'phone', kind: 'phone', name: 'Pairing code' },
    ],
    termsRisk: false,
  },
  signal: {
    network: 'signal',
    name: 'Signal',
    maturity: 'stable',
    flows: [{ id: 'qr', kind: 'qr', name: 'Link a device' }],
    termsRisk: false,
  },
  gmessages: {
    network: 'gmessages',
    name: 'Google Messages',
    maturity: 'stable',
    flows: [{ id: 'google', kind: 'cookies', name: 'Sign in with Google' }],
    termsRisk: false,
  },
  telegram: {
    network: 'telegram',
    name: 'Telegram',
    maturity: 'beta',
    flows: [
      { id: 'qr', kind: 'qr', name: 'Scan a QR code' },
      { id: 'phone', kind: 'form', name: 'Phone number' },
    ],
    termsRisk: false,
  },
  meta: {
    network: 'meta',
    name: 'Messenger',
    maturity: 'beta',
    // mautrix-meta's cookie flows. Its username-and-password flows aren't offered: they can
    // need choices, images and in-browser checks the stepper can't show (docs/networks/meta.md).
    flows: [
      { id: 'facebook', kind: 'cookies', name: 'Cookies from facebook.com' },
      { id: 'messenger', kind: 'cookies', name: 'Cookies from messenger.com' },
    ],
    termsRisk: true,
  },
  instagram: {
    network: 'instagram',
    name: 'Instagram',
    maturity: 'beta',
    // Cookies only, as for Messenger (docs/networks/instagram.md).
    flows: [{ id: 'instagram', kind: 'cookies', name: 'Cookies from instagram.com' }],
    termsRisk: true,
  },
  discord: {
    network: 'discord',
    name: 'Discord',
    maturity: 'experimental',
    flows: [
      { id: 'qr', kind: 'qr', name: 'Scan a QR code' },
      { id: 'token', kind: 'form', name: 'Token' },
    ],
    termsRisk: true,
  },
  slack: {
    network: 'slack',
    name: 'Slack',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/slack.md.
    flows: [],
    termsRisk: false,
  },
  groupme: {
    network: 'groupme',
    name: 'GroupMe',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/groupme.md.
    flows: [],
    termsRisk: false,
  },
  gvoice: {
    network: 'gvoice',
    name: 'Google Voice',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/gvoice.md.
    flows: [],
    termsRisk: false,
  },
  linkedin: {
    network: 'linkedin',
    name: 'LinkedIn',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/linkedin.md.
    flows: [],
    termsRisk: false,
  },
  twitter: {
    network: 'twitter',
    name: 'X',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/twitter.md.
    flows: [],
    termsRisk: false,
  },
  bluesky: {
    network: 'bluesky',
    name: 'Bluesky',
    maturity: 'experimental',
    // Filled in from the connector's login flows; see docs/networks/bluesky.md.
    flows: [],
    termsRisk: false,
  },
  fake: {
    network: 'fake',
    name: 'Fake network',
    maturity: 'experimental',
    flows: [{ id: 'username', kind: 'form', name: 'Any username' }],
    termsRisk: false,
  },
}

/** Which inbox view a chat list shows. */
export type ChatView = 'inbox' | 'archived' | 'snoozed' | 'requests' | 'blocked'

/**
 * A chat's newest message, for its row in the list. Open `sealed` as a message: kind
 * `message`, object ID `objectId`. It's the latest edit when there is one, as in
 * `messages.list`. `null` when the message was deleted (`redacted`) or is too big to carry
 * here (over 4 KiB sealed): show "Message deleted" or "Message".
 */
export interface LastMessage {
  messageId: string
  /** Its network time. */
  at: number
  /** Sent by the person. */
  self: boolean
  /** Who sent it, when it wasn't the person. */
  ghostId?: string
  redacted: boolean
  sealed: Envelope | null
  objectId: string
}

/** One row of the chat list, as `chats.list` returns it. Everything readable is sealed. */
export interface ChatRow {
  _id: string
  network: Network
  networkAccountId: string | null
  kind: ChatKind
  /** Name, topic and avatar, sealed with kind `chat` and object ID `portalId`. */
  sealedMeta: Envelope | null
  portalId: string
  unreadCount: number
  /** Unread messages that mention the person, as the bridge host flags them. */
  mentionCount: number
  /** Set by the person, whatever the unread count. */
  markedUnread: boolean
  pinned: boolean
  archived: boolean
  mutedUntil: number | null
  snoozedUntil: number | null
  /** The snooze has passed, or a new message ended it: show it as back. */
  woke: boolean
  /** A message request: someone the person hasn't accepted yet. */
  isRequest: boolean
  blocked: boolean
  labelIds: string[]
  lastMessageAt: number
  /** The newest message, as `messages.list` orders them. `null` when the chat has none. */
  lastMessage: LastMessage | null
}

export type SidebarLayout = 'focused' | 'simple'

export interface Preferences {
  sidebarLayout: SidebarLayout
}

export const DEFAULT_PREFERENCES: Preferences = { sidebarLayout: 'simple' }

/** One network's health for the person, for the status bar. */
export interface NetworkHealth {
  network: Network
  /** A bridge host for this network has been heard from in the last two minutes. */
  bridgeOnline: boolean
  accounts: { networkAccountId: string; state: LoginState; error: ErrorCode | null; lastHealthyAt: number | null }[]
  /** `online`: everything connected. `degraded`: some accounts aren't. `offline`: no bridge host, or no account connected. */
  status: 'online' | 'degraded' | 'offline' | 'none'
}

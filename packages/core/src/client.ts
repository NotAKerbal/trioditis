// What the desktop/web client works with: network capabilities, chat list rows, bridge health
// and preferences. docs/architecture/client-api.md describes the functions that return them.

import type { Envelope } from '@trioditis/crypto'
import type { ChatKind, Maturity, Network } from './index.ts'
import type { ErrorCode, LoginState } from './bridge-protocol.ts'

/** How a person can connect an account on a network. */
export interface LoginFlow {
  /** Passed to `logins.start` as `flowId`. */
  id: string
  /**
   * What the stepper shows first: a QR code to scan, a code to type on the phone, a website to
   * sign in on (or its cookies to paste), or a form.
   */
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

/**
 * The networks `contacts.sync` works on: those where a contact's ID can be their phone number,
 * which the person's own chats with them carry. Mirrors the bridge host's numberIDNetworks.
 */
export const CONTACT_LIST_NETWORKS: readonly Network[] = ['whatsapp']

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
    // Stable is the v1 target (docs/PLAN.md); experimental until it has been used with a real
    // account, on the bridge host's patched mautrix-signal (docs/networks/signal.md, Sending).
    maturity: 'experimental',
    flows: [{ id: 'qr', kind: 'qr', name: 'Link a device' }],
    termsRisk: false,
  },
  gmessages: {
    network: 'gmessages',
    name: 'Google Messages',
    // Stable is the v1 target (docs/PLAN.md), reached after the conformance suite and a week on
    // the canary ledger with a real account. See docs/networks/gmessages.md.
    maturity: 'beta',
    // The connector's only flow: Google account cookies, then an emoji tapped on the phone.
    // Its QR flow is switched off upstream.
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
      { id: 'facebook', kind: 'cookies', name: 'Sign in on facebook.com' },
      { id: 'messenger', kind: 'cookies', name: 'Sign in on messenger.com' },
    ],
    termsRisk: true,
  },
  instagram: {
    network: 'instagram',
    name: 'Instagram',
    maturity: 'beta',
    // Cookies only, as for Messenger (docs/networks/instagram.md).
    flows: [{ id: 'instagram', kind: 'cookies', name: 'Sign in on instagram.com' }],
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
    // The connector's IDs. The token flow comes first: it needs nothing the stepper can't
    // show, where the email flow can stop at a CAPTCHA or a workspace list. See
    // docs/networks/slack.md.
    flows: [
      { id: 'token', kind: 'cookies', name: 'Sign in on slack.com' },
      { id: 'email', kind: 'form', name: 'Email code' },
      { id: 'app', kind: 'form', name: 'Slack app (bot)' },
    ],
    // A browser session's token used by an unofficial client, against Slack's acceptable
    // use policy, and against many workspaces' own rules.
    termsRisk: true,
  },
  groupme: {
    network: 'groupme',
    name: 'GroupMe',
    maturity: 'experimental',
    // The connector's third flow, `web`, reads the token from an embedded browser, which the
    // stepper doesn't have; pasting the same token is `access-token`. See docs/networks/groupme.md.
    flows: [
      { id: 'access-token', kind: 'form', name: 'Access token' },
      { id: 'password', kind: 'form', name: 'Email or phone and password' },
    ],
    // GroupMe has a public API for third-party apps using a person's own access token.
    termsRisk: false,
  },
  gvoice: {
    network: 'gvoice',
    name: 'Google Voice',
    maturity: 'experimental',
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in with Google' }],
    // Google account cookies driving voice.google.com's own API as an unofficial client, which
    // Google checks for. See docs/networks/gvoice.md.
    termsRisk: true,
  },
  linkedin: {
    network: 'linkedin',
    name: 'LinkedIn',
    maturity: 'experimental',
    // The connector's email-and-password flow isn't offered: its verification steps ask the
    // person to pick from options, which the stepper can't show yet. See docs/networks/linkedin.md.
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in on linkedin.com' }],
    termsRisk: true,
  },
  twitter: {
    network: 'twitter',
    name: 'X',
    maturity: 'experimental',
    // The connector's password flow needs a browser token made by script in a web view, which
    // the stepper can't run. See docs/networks/twitter.md.
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in on x.com' }],
    termsRisk: true,
  },
  bluesky: {
    network: 'bluesky',
    name: 'Bluesky',
    maturity: 'experimental',
    // An app password with direct messages allowed; see docs/networks/bluesky.md.
    flows: [{ id: 'password', kind: 'form', name: 'App password' }],
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

/**
 * A message that just arrived from someone else, as `messages.arrivals` returns it, for a
 * notification. Never imported history or the person's own.
 */
export interface Arrival {
  /** When the server stored it: arrivals are newest first by this, not by network time. */
  arrivedAt: number
  /** Its latest content, opened as `LastMessage` is: `sealed` is null when too large to show. */
  message: LastMessage
  chat: ChatRow
}

/** What `messages.arrivals` returns. */
export interface ArrivalFeed {
  /**
   * When the newest live message of any kind arrived (null: none yet). Notify only for
   * arrivals after the `latest` of the first answer.
   */
  latest: number | null
  /** Newest first, at most ten. */
  arrivals: Arrival[]
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

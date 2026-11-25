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
  /** It has reactions, so the person can react (`messages.react`). See docs/networks. */
  reactions: boolean
  /**
   * The person can change the text of their own messages (`messages.edit`): for `maxAgeMs`
   * after sending, or with no limit when that's null, and at most `maxEdits` times where the
   * network caps it. Null when the network can't edit.
   */
  edit: { maxAgeMs: number | null; maxEdits?: number } | null
  /**
   * The person can delete their own messages (`messages.remove`): for everyone in the chat, or
   * only from their own account (`forEveryone` false, where others may keep it), or either,
   * depending on the chat (`'depends'`), for `maxAgeMs` after sending or with no limit. Null when
   * the network can't delete.
   */
  delete: { forEveryone: boolean | 'depends'; maxAgeMs: number | null } | null
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/**
 * The networks `contacts.sync` works on: those where a contact's ID can be their phone number,
 * which the person's own chats with them carry. Mirrors the bridge host's numberIDNetworks.
 */
export const CONTACT_LIST_NETWORKS: readonly Network[] = ['whatsapp']

/**
 * What a new chat can start from on each network (`newChats.start`): one of the person's
 * contacts there, a phone number, or a username. Mirrors the bridge host's startTargets, which
 * says why each network is as it is. A network missing here can't start chats.
 */
export const START_TARGETS: Partial<Record<Network, { contact: boolean; phone: boolean; username: boolean }>> = {
  whatsapp: { contact: true, phone: true, username: false },
  signal: { contact: true, phone: true, username: true },
  gmessages: { contact: true, phone: true, username: false },
  telegram: { contact: true, phone: false, username: false },
  meta: { contact: true, phone: false, username: false },
  instagram: { contact: true, phone: false, username: false },
  slack: { contact: true, phone: false, username: false },
  linkedin: { contact: true, phone: false, username: false },
  twitter: { contact: false, phone: false, username: true },
  // A username on iMessage is the email address someone's Apple ID uses.
  imessage: { contact: true, phone: true, username: true },
}

/**
 * What each network offers. Mirrors the bridge host's connectors; see docs/PLAN.md, Networks.
 * `edit` and `delete` follow each connector's room features (its `GetCapabilities`): bridgev2
 * refuses an edit past the connector's age limit, and the network a late deletion, so the app
 * doesn't offer them then.
 */
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
    reactions: true,
    edit: { maxAgeMs: 15 * MINUTE },
    delete: { forEveryone: true, maxAgeMs: 48 * HOUR },
  },
  signal: {
    network: 'signal',
    name: 'Signal',
    // Stable is the v1 target (docs/PLAN.md); experimental until it has been used with a real
    // account, on the bridge host's patched mautrix-signal (docs/networks/signal.md, Sending).
    maturity: 'experimental',
    flows: [{ id: 'qr', kind: 'qr', name: 'Link a device' }],
    termsRisk: false,
    reactions: true,
    edit: { maxAgeMs: 24 * HOUR, maxEdits: 10 },
    delete: { forEveryone: true, maxAgeMs: 24 * HOUR },
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
    reactions: true,
    // RCS and SMS can’t take a message back: deleting removes it from the phone only.
    edit: null,
    delete: { forEveryone: false, maxAgeMs: null },
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
    reactions: true,
    // Telegram's edit_time_limit: 48 hours (only Saved Messages has none).
    edit: { maxAgeMs: 48 * HOUR },
    delete: { forEveryone: true, maxAgeMs: null },
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
    reactions: true,
    // mautrix-meta can report an edit or a deletion done that the network refused or didn't
    // confirm (it doesn't check the answer), and a deletion it reports clears the stored copy, so
    // neither is offered until the bridge host checks those answers itself.
    edit: null,
    delete: null,
  },
  instagram: {
    network: 'instagram',
    name: 'Instagram',
    maturity: 'beta',
    // Cookies only, as for Messenger (docs/networks/instagram.md).
    flows: [{ id: 'instagram', kind: 'cookies', name: 'Sign in on instagram.com' }],
    termsRisk: true,
    reactions: true,
    // mautrix-meta can report an edit or a deletion done that the network refused or didn't
    // confirm (it doesn't check the answer), and a deletion it reports clears the stored copy, so
    // neither is offered until the bridge host checks those answers itself.
    edit: null,
    delete: null,
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
    reactions: true,
    // The bridge host has no Discord connector yet.
    edit: null,
    delete: null,
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
    reactions: true,
    edit: { maxAgeMs: null },
    delete: { forEveryone: true, maxAgeMs: null },
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
    reactions: true,
    // The connector keeps an edit's text in the bridge database unsealed (its native_content), so
    // edits aren't offered.
    edit: null,
    delete: { forEveryone: true, maxAgeMs: null },
  },
  gvoice: {
    network: 'gvoice',
    name: 'Google Voice',
    maturity: 'experimental',
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in with Google' }],
    // Google account cookies driving voice.google.com's own API as an unofficial client, which
    // Google checks for. See docs/networks/gvoice.md.
    termsRisk: true,
    reactions: false,
    edit: null,
    delete: null,
  },
  linkedin: {
    network: 'linkedin',
    name: 'LinkedIn',
    maturity: 'experimental',
    // The connector's email-and-password flow isn't offered: its verification steps ask the
    // person to pick from options, which the stepper can't show yet. See docs/networks/linkedin.md.
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in on linkedin.com' }],
    termsRisk: true,
    reactions: true,
    edit: { maxAgeMs: 60 * MINUTE },
    delete: { forEveryone: true, maxAgeMs: 60 * MINUTE },
  },
  twitter: {
    network: 'twitter',
    name: 'X',
    maturity: 'experimental',
    // The connector's password flow needs a browser token made by script in a web view, which
    // the stepper can't run. See docs/networks/twitter.md.
    flows: [{ id: 'cookies', kind: 'cookies', name: 'Sign in on x.com' }],
    termsRisk: true,
    reactions: true,
    // Only an encrypted (XChat) conversation can be edited, and only it deletes for everyone; any
    // other deletes for the person only. Which one a chat is isn't known here, so edits aren't
    // offered and a deletion says it depends.
    edit: null,
    delete: { forEveryone: 'depends', maxAgeMs: null },
  },
  bluesky: {
    network: 'bluesky',
    name: 'Bluesky',
    maturity: 'experimental',
    // An app password with direct messages allowed; see docs/networks/bluesky.md.
    flows: [{ id: 'password', kind: 'form', name: 'App password' }],
    termsRisk: false,
    reactions: false,
    edit: null,
    delete: null,
  },
  imessage: {
    network: 'imessage',
    name: 'iMessage',
    maturity: 'experimental',
    // The person's own Mac runs BlueBubbles Server, signed in to Messages; the login is its
    // address and password. See docs/networks/imessage.md.
    flows: [{ id: 'bluebubbles', kind: 'form', name: 'BlueBubbles Server' }],
    // BlueBubbles drives the Messages app on the person's own Mac, as they would.
    termsRisk: false,
    // Sending anything needs BlueBubbles' Private API on the Mac (its other way of sending can
    // send twice); without it the Mac only receives, and refuses each send as unsupported.
    // Messages allows an edit for 15 minutes, five times, and unsending for 2 minutes.
    reactions: true,
    edit: { maxAgeMs: 15 * MINUTE, maxEdits: 5 },
    delete: { forEveryone: true, maxAgeMs: 2 * MINUTE },
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
  /** For a group: the members whose pictures make one, sealed with kind `chat`, object ID `<portalId>/collage`. */
  sealedCollage: Envelope | null
  portalId: string
  unreadCount: number
  /**
   * Goes up by one with every message counted unread, so two answers with the same count can
   * still be told apart: one at 1, marked read, then another at 1.
   */
  unreadRev: number
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

/**
 * A bridge host heard from within this long is online; it heartbeats every 30 seconds, so one
 * missing for two minutes has stopped, whether or not it said so on the way out.
 */
export const BRIDGE_HOST_STALE_MS = 2 * 60_000

export type NetworkStatus = 'online' | 'degraded' | 'offline' | 'none'

/** One network's health for the person, for the status bar. */
export interface NetworkHealth {
  network: Network
  /** A bridge host for this network had been heard from in the last two minutes when the query ran. */
  bridgeOnline: boolean
  /** When it was last heard from, to judge `bridgeOnline` again as time passes; null if never. */
  bridgeLastSeenAt?: number | null
  accounts: { networkAccountId: string; state: LoginState; error: ErrorCode | null; lastHealthyAt: number | null }[]
  /** `online`: everything connected. `degraded`: some accounts aren't. `offline`: no bridge host, or no account connected. */
  status: NetworkStatus
}

/** Sums up a network's accounts (those not logged out) and its bridge for the status bar. */
export function networkStatus(accounts: readonly { state: LoginState }[], bridgeOnline: boolean): NetworkStatus {
  const connected = accounts.filter((account) => account.state === 'CONNECTED').length
  if (accounts.length === 0) return 'none'
  if (!bridgeOnline || connected === 0) return 'offline'
  return connected < accounts.length ? 'degraded' : 'online'
}

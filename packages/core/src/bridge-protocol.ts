// Wire types for the bridge host ↔ gateway protocol, docs/architecture/bridge-protocol.md.
// The Go side (apps/bridge-host/internal/protocol) mirrors these.

import type { Envelope } from '@trioditis/crypto'
import type { ChatKind, Network } from './index.ts'

export const PROTOCOL_VERSION = 1

/**
 * Why something failed. Errors are always one of these codes, never free text: a connector's
 * message can quote what the person typed. See bridge-protocol.md, Errors.
 */
export const ERROR_CODES = [
  'network_rejected',
  'not_connected',
  'timeout',
  'invalid_command',
  'expired',
  'unsupported',
  'rate_limited',
  'bad_credentials',
  'login_failed',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export type Sender = { self: true } | { ghostId: string }

interface EventBase {
  seq: number
  userId: string
  loginId: string
  /** Bridge host time, ms since the epoch. */
  at: number
}

export interface MessageEvent extends EventBase {
  type: 'message'
  portalId: string
  eventId: string
  networkTs: number
  sender: Sender
  sealed: Envelope
  historical: boolean
  replyTo?: string
  threadRoot?: string
  clientMessageId?: string
}

export interface EditEvent extends EventBase {
  type: 'edit'
  portalId: string
  eventId: string
  targetEventId: string
  networkTs: number
  sender: Sender
  sealed: Envelope
}

export interface ReactionEvent extends EventBase {
  type: 'reaction'
  portalId: string
  eventId: string
  targetEventId: string
  sender: Sender
  key: string
  networkTs: number
}

export interface ReactionRemoveEvent extends EventBase {
  type: 'reactionRemove'
  portalId: string
  targetEventId: string
  sender: Sender
  key: string
}

export interface RedactionEvent extends EventBase {
  type: 'redaction'
  portalId: string
  targetEventId: string
  sender: Sender
  networkTs: number
}

export interface ReceiptEvent extends EventBase {
  type: 'receipt'
  portalId: string
  sender: Sender
  upToEventId: string
  networkTs: number
}

export interface TypingEvent extends EventBase {
  type: 'typing'
  portalId: string
  sender: Sender
  typing: boolean
  timeoutMs: number
}

export interface ChatEvent extends EventBase {
  type: 'chat'
  portalId: string
  kind: Exclude<ChatKind, 'agent'>
  sealed: Envelope
  parentPortalId?: string
  deleted?: boolean
}

export interface ContactEvent extends EventBase {
  type: 'contact'
  ghostId: string
  sealed: Envelope
}

export const LOGIN_STATES = [
  'CONNECTING',
  'CONNECTED',
  'TRANSIENT_DISCONNECT',
  'BAD_CREDENTIALS',
  'UNKNOWN_ERROR',
  'LOGGED_OUT',
] as const
export type LoginState = (typeof LOGIN_STATES)[number]

export interface LoginStateEvent extends EventBase {
  type: 'loginState'
  state: LoginState
  error?: ErrorCode
}

export interface LoginStep {
  stepId: string
  type: 'displayAndWait' | 'userInput' | 'cookies' | 'complete' | 'cancelled' | 'error'
  instructions?: string
  display?: { type: 'qr' | 'code' | 'emoji' | 'nothing'; data?: string }
  fields?: { id: string; type: string; name: string; description?: string; pattern?: string }[]
  cookies?: { url: string; userAgent?: string; fields: { id: string; required: boolean }[] }
  loginId?: string
  error?: ErrorCode
}

export interface LoginStepEvent extends EventBase {
  type: 'loginStep'
  loginSessionId: string
  step: LoginStep
}

export type SendStatus = 'submitted' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown'

export interface SendStatusEvent extends EventBase {
  type: 'sendStatus'
  clientMessageId: string
  status: SendStatus
  eventId?: string
  error?: ErrorCode
}

export interface BackfillDoneEvent extends EventBase {
  type: 'backfillDone'
  portalId: string
  direction: 'backward' | 'forward'
  more: boolean
}

export type BridgeEvent =
  | MessageEvent
  | EditEvent
  | ReactionEvent
  | ReactionRemoveEvent
  | RedactionEvent
  | ReceiptEvent
  | TypingEvent
  | ChatEvent
  | ContactEvent
  | LoginStateEvent
  | LoginStepEvent
  | SendStatusEvent
  | BackfillDoneEvent

export interface EventBatch {
  hostId: string
  network: Network
  /** Informational only: the gateway takes command addresses from its own configuration. */
  commandAddr?: string
  /** Empty for a heartbeat. */
  events: BridgeEvent[]
}

export type EventBatchResponse = { ackedThrough: number }
export type EventBatchConflict = { expectedSeq: number }

interface CommandBase {
  commandId: string
  userId: string
  /** Absent only for `loginStart`, which has no login yet. */
  loginId?: string
}

export type BridgeCommand = CommandBase &
  (
    | { type: 'send'; portalId: string; clientMessageId: string; sealed: Envelope; notAfter: number; replyTo?: string }
    | {
        type: 'edit'
        portalId: string
        targetEventId: string
        clientMessageId: string
        sealed: Envelope
        notAfter?: number
      }
    | { type: 'react' | 'unreact'; portalId: string; targetEventId: string; key: string }
    | { type: 'redact'; portalId: string; targetEventId: string }
    | { type: 'markRead'; portalId: string; upToEventId: string }
    | { type: 'typing'; portalId: string; typing: boolean }
    | { type: 'loginStart'; loginSessionId: string; network: Network; flowId?: string }
    | { type: 'loginSubmit'; loginSessionId: string; stepId: string; sealed: Envelope }
    | { type: 'loginCancel'; loginSessionId: string }
    | { type: 'logout' }
    | { type: 'backfill'; portalId: string; beforeEventId?: string; limit: number }
  )

export interface RecipientKeys {
  identity: { kid: string; publicKey: string }
  agentAccess: { kid: string; publicKey: string }
  agentGrantedPortals: string[]
}

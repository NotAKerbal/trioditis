// Package protocol holds the wire types of the bridge host ↔ gateway protocol,
// docs/architecture/bridge-protocol.md. It mirrors packages/core/src/bridge-protocol.ts.
package protocol

import (
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

const Version = 1

// Sender is `{"self": true}` or `{"ghostId": "…"}`.
type Sender struct {
	Self    bool   `json:"self,omitempty"`
	GhostID string `json:"ghostId,omitempty"`
}

var SelfSender = Sender{Self: true}

// Event is one entry of an event batch. Which fields are set depends on Type; the JSON
// matches the TypeScript union, which leaves absent fields out.
type Event struct {
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	UserID  string `json:"userId"`
	LoginID string `json:"loginId"`
	At      int64  `json:"at"`

	PortalID        string         `json:"portalId,omitempty"`
	EventID         string         `json:"eventId,omitempty"`
	TargetEventID   string         `json:"targetEventId,omitempty"`
	NetworkTS       int64          `json:"networkTs,omitempty"`
	Sender          *Sender        `json:"sender,omitempty"`
	Sealed          *seal.Envelope `json:"sealed,omitempty"`
	Historical      *bool          `json:"historical,omitempty"`
	ReplyTo         string         `json:"replyTo,omitempty"`
	ThreadRoot      string         `json:"threadRoot,omitempty"`
	ClientMessageID string         `json:"clientMessageId,omitempty"`

	Key string `json:"key,omitempty"`

	UpToEventID string `json:"upToEventId,omitempty"`
	Typing      *bool  `json:"typing,omitempty"`
	TimeoutMS   *int64 `json:"timeoutMs,omitempty"`

	Kind           string `json:"kind,omitempty"`
	ParentPortalID string `json:"parentPortalId,omitempty"`
	Deleted        bool   `json:"deleted,omitempty"`

	GhostID string `json:"ghostId,omitempty"`

	State string `json:"state,omitempty"`
	// Error is always one of the error codes below, never free text.
	Error string `json:"error,omitempty"`

	LoginSessionID string     `json:"loginSessionId,omitempty"`
	Step           *LoginStep `json:"step,omitempty"`

	Status string `json:"status,omitempty"`

	Direction string `json:"direction,omitempty"`
	More      *bool  `json:"more,omitempty"`
}

// Event types.
const (
	EventMessage        = "message"
	EventEdit           = "edit"
	EventReaction       = "reaction"
	EventReactionRemove = "reactionRemove"
	EventRedaction      = "redaction"
	EventReceipt        = "receipt"
	EventTyping         = "typing"
	EventChat           = "chat"
	EventContact        = "contact"
	EventLoginState     = "loginState"
	EventLoginStep      = "loginStep"
	EventSendStatus     = "sendStatus"
	EventBackfillDone   = "backfillDone"
)

// Send statuses.
const (
	StatusSubmitted = "submitted"
	StatusSent      = "sent"
	StatusDelivered = "delivered"
	StatusRead      = "read"
	StatusFailed    = "failed"
	StatusUnknown   = "unknown"
)

// Error codes. Every error field and every 4xx body uses one of these; connector error
// text, user input and content never leave the bridge host.
const (
	ErrNetworkRejected = "network_rejected"
	ErrNotConnected    = "not_connected"
	ErrTimeout         = "timeout"
	ErrInvalidCommand  = "invalid_command"
	ErrExpired         = "expired"
	ErrUnsupported     = "unsupported"
	ErrRateLimited     = "rate_limited"
	ErrBadCredentials  = "bad_credentials"
	ErrLoginFailed     = "login_failed"
	ErrInternal        = "internal"
)

// LoginStep is one step of a login flow, rendered by the app's generic login stepper.
type LoginStep struct {
	StepID       string        `json:"stepId"`
	Type         string        `json:"type"`
	Instructions string        `json:"instructions,omitempty"`
	Display      *LoginDisplay `json:"display,omitempty"`
	Fields       []LoginField  `json:"fields,omitempty"`
	Cookies      *LoginCookies `json:"cookies,omitempty"`
	LoginID      string        `json:"loginId,omitempty"`
	Error        string        `json:"error,omitempty"`
}

// Login step types.
const (
	StepDisplayAndWait = "displayAndWait"
	StepUserInput      = "userInput"
	StepCookies        = "cookies"
	StepComplete       = "complete"
	StepCancelled      = "cancelled"
	StepError          = "error"
)

type LoginDisplay struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
}

type LoginField struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Pattern     string `json:"pattern,omitempty"`
}

type LoginCookies struct {
	URL       string             `json:"url"`
	UserAgent string             `json:"userAgent,omitempty"`
	Fields    []LoginCookieField `json:"fields"`
}

type LoginCookieField struct {
	ID       string `json:"id"`
	Required bool   `json:"required"`
}

// EventBatch is the body of POST /v1/events.
type EventBatch struct {
	HostID      string   `json:"hostId"`
	Network     string   `json:"network"`
	CommandAddr string   `json:"commandAddr"`
	Events      []*Event `json:"events"`
}

type EventBatchResponse struct {
	AckedThrough int64 `json:"ackedThrough"`
}

type EventBatchConflict struct {
	ExpectedSeq int64 `json:"expectedSeq"`
}

// Command is the body of POST /v1/commands.
type Command struct {
	CommandID string `json:"commandId"`
	Type      string `json:"type"`
	UserID    string `json:"userId"`
	LoginID   string `json:"loginId,omitempty"`

	PortalID        string         `json:"portalId,omitempty"`
	ClientMessageID string         `json:"clientMessageId,omitempty"`
	Sealed          *seal.Envelope `json:"sealed,omitempty"`
	// NotAfter (ms since the epoch) is the latest a send or edit may still go out.
	NotAfter      int64  `json:"notAfter,omitempty"`
	ReplyTo       string `json:"replyTo,omitempty"`
	TargetEventID string `json:"targetEventId,omitempty"`
	Key           string `json:"key,omitempty"`
	UpToEventID   string `json:"upToEventId,omitempty"`
	Typing        bool   `json:"typing,omitempty"`

	LoginSessionID string `json:"loginSessionId,omitempty"`
	Network        string `json:"network,omitempty"`
	FlowID         string `json:"flowId,omitempty"`
	StepID         string `json:"stepId,omitempty"`

	BeforeEventID string `json:"beforeEventId,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

// Command types.
const (
	CommandSend        = "send"
	CommandEdit        = "edit"
	CommandReact       = "react"
	CommandUnreact     = "unreact"
	CommandRedact      = "redact"
	CommandMarkRead    = "markRead"
	CommandTyping      = "typing"
	CommandLoginStart  = "loginStart"
	CommandLoginSubmit = "loginSubmit"
	CommandLoginCancel = "loginCancel"
	CommandLogout      = "logout"
	CommandBackfill    = "backfill"
)

// LoginSubmitPlaintext is what a sealed loginSubmit envelope holds.
type LoginSubmitPlaintext struct {
	Input map[string]string `json:"input"`
}

// RecipientKey is a public key with its key ID.
type RecipientKey struct {
	KID       string `json:"kid"`
	PublicKey string `json:"publicKey"`
}

// RecipientKeys is the response of GET /v1/keys/:userId.
type RecipientKeys struct {
	Identity            RecipientKey `json:"identity"`
	AgentAccess         RecipientKey `json:"agentAccess"`
	AgentGrantedPortals []string     `json:"agentGrantedPortals"`
}

// MessagePlaintext is a message's sealed content, docs/architecture/sealing.md.
type MessagePlaintext struct {
	Type        string       `json:"type"`
	Body        string       `json:"body"`
	HTML        string       `json:"html,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Mentions    []string     `json:"mentions,omitempty"`
}

type Attachment struct {
	MediaID    string `json:"mediaId"`
	Mime       string `json:"mime"`
	Size       int    `json:"size"`
	Name       string `json:"name,omitempty"`
	Key        string `json:"key"`
	Nonce      string `json:"nonce"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMS int    `json:"durationMs,omitempty"`
}

// ChatPlaintext is a chat's sealed metadata.
type ChatPlaintext struct {
	Name   string      `json:"name,omitempty"`
	Topic  string      `json:"topic,omitempty"`
	Avatar *Attachment `json:"avatar,omitempty"`
}

// ContactPlaintext is a contact's sealed profile.
type ContactPlaintext struct {
	Name   string      `json:"name,omitempty"`
	Handle string      `json:"handle,omitempty"`
	Avatar *Attachment `json:"avatar,omitempty"`
}

// Package protocol holds the wire types of the bridge host ↔ gateway protocol,
// docs/architecture/bridge-protocol.md. It mirrors packages/core/src/bridge-protocol.ts.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

const Version = 1

// Sender is `{"self": true}` or `{"ghostId": "…"}`.
type Sender struct {
	Self    bool   `json:"self,omitempty"`
	GhostID string `json:"ghostId,omitempty"`
}

var SelfSender = Sender{Self: true}

// MarshalJSON writes exactly one of the two shapes the backend accepts.
func (s Sender) MarshalJSON() ([]byte, error) {
	if s.Self {
		return []byte(`{"self":true}`), nil
	}
	return json.Marshal(struct {
		GhostID string `json:"ghostId"`
	}{s.GhostID})
}

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
	// MentionsMe says a message mentions the person (by name, or the whole chat): the bridge
	// host can tell, as it sees the plaintext. It feeds the inbox's Mentions view.
	MentionsMe bool `json:"mentionsMe,omitempty"`

	Key string `json:"key,omitempty"`

	UpToEventID string `json:"upToEventId,omitempty"`
	Typing      *bool  `json:"typing,omitempty"`
	TimeoutMS   *int64 `json:"timeoutMs,omitempty"`

	Kind           string `json:"kind,omitempty"`
	ParentPortalID string `json:"parentPortalId,omitempty"`
	Deleted        bool   `json:"deleted,omitempty"`
	// IsRequest is whether the network says the chat is a message request the person hasn't
	// accepted. Nil leaves what the backend has alone.
	IsRequest *bool `json:"isRequest,omitempty"`

	GhostID string `json:"ghostId,omitempty"`

	State string `json:"state,omitempty"`
	// Error is always one of the error codes below, never free text.
	Error string `json:"error,omitempty"`

	LoginSessionID string     `json:"loginSessionId,omitempty"`
	Step           *LoginStep `json:"step,omitempty"`

	Status string `json:"status,omitempty"`

	Direction string `json:"direction,omitempty"`
	More      *bool  `json:"more,omitempty"`

	// RequestID is the startChat request a chatStarted event answers.
	RequestID string `json:"requestId,omitempty"`

	// bare marks a stand-in for a journal event too big to send: only the fields every event
	// has are written, so the gateway quarantines it instead of refusing the whole batch.
	bare bool
}

// Size limits, from docs/architecture/bridge-protocol.md (Sizes, and the gateway's batch
// rules). The backend quarantines anything over them, and the gateway refuses a request
// body over 32 MiB, so the bridge host keeps every event within them.
const (
	// MaxMessageSealedBytes is the most a message or edit's sealed ciphertext may hold.
	MaxMessageSealedBytes = 256 * 1024
	// MaxMetadataSealedBytes is the most a chat or contact's sealed ciphertext may hold.
	MaxMetadataSealedBytes = 8 * 1024
	// MaxEventBytes is the most one event's JSON may hold (the gateway quarantines more).
	MaxEventBytes = 1024 * 1024
	// MaxClientSealedBytes is the most a client may seal into a send, an edit or login
	// input (the backend refuses more, so a bigger one didn't come from a client).
	MaxClientSealedBytes = 64 * 1024
)

// eventShape is what one event type carries beyond seq, type, userId, loginId and at.
type eventShape struct{ required, optional []string }

// eventShapes mirrors the backend's bridgeEvent validator
// (packages/backend/convex/validators.ts), which the gateway also checks every event
// against before sending it on: a field it doesn't expect, or a required one missing, gets
// the event quarantined.
var eventShapes = map[string]eventShape{
	EventMessage:            {[]string{"portalId", "eventId", "networkTs", "sender", "sealed", "historical"}, []string{"replyTo", "threadRoot", "clientMessageId", "mentionsMe"}},
	EventEdit:               {[]string{"portalId", "eventId", "targetEventId", "networkTs", "sender", "sealed"}, []string{"clientMessageId"}},
	EventReaction:           {[]string{"portalId", "eventId", "targetEventId", "sender", "key", "networkTs"}, nil},
	EventReactionRemove:     {[]string{"portalId", "targetEventId", "sender", "key"}, nil},
	EventRedaction:          {[]string{"portalId", "targetEventId", "sender", "networkTs"}, nil},
	EventReceipt:            {[]string{"portalId", "sender", "upToEventId", "networkTs"}, nil},
	EventTyping:             {[]string{"portalId", "sender", "typing", "timeoutMs"}, nil},
	EventChat:               {[]string{"portalId", "kind", "sealed"}, []string{"parentPortalId", "deleted", "isRequest"}},
	EventContact:            {[]string{"ghostId", "sealed"}, nil},
	EventContactIdentifiers: {[]string{"ghostId", "sealed"}, nil},
	EventChatStarted:        {[]string{"requestId"}, []string{"portalId", "error"}},
	EventLoginState:         {[]string{"state"}, []string{"error", "sealed"}},
	EventLoginStep:          {[]string{"loginSessionId", "step"}, nil},
	EventSendStatus:         {[]string{"clientMessageId", "status"}, []string{"eventId", "error"}},
	EventBackfillDone:       {[]string{"portalId", "direction", "more"}, nil},
}

// field returns an event field by its JSON name, and whether it is set.
func (e *Event) field(name string) (any, bool) {
	str := func(s string) (any, bool) { return s, s != "" }
	switch name {
	case "portalId":
		return str(e.PortalID)
	case "eventId":
		return str(e.EventID)
	case "targetEventId":
		return str(e.TargetEventID)
	case "networkTs":
		return e.NetworkTS, e.NetworkTS != 0
	case "sender":
		return e.Sender, e.Sender != nil && (e.Sender.Self || e.Sender.GhostID != "")
	case "sealed":
		return e.Sealed, e.Sealed != nil
	case "historical":
		return e.Historical, e.Historical != nil
	case "replyTo":
		return str(e.ReplyTo)
	case "threadRoot":
		return str(e.ThreadRoot)
	case "clientMessageId":
		return str(e.ClientMessageID)
	case "mentionsMe":
		return e.MentionsMe, e.MentionsMe
	case "isRequest":
		return e.IsRequest, e.IsRequest != nil
	case "key":
		return str(e.Key)
	case "upToEventId":
		return str(e.UpToEventID)
	case "typing":
		return e.Typing, e.Typing != nil
	case "timeoutMs":
		return e.TimeoutMS, e.TimeoutMS != nil
	case "kind":
		return str(e.Kind)
	case "parentPortalId":
		return str(e.ParentPortalID)
	case "deleted":
		return e.Deleted, e.Deleted
	case "ghostId":
		return str(e.GhostID)
	case "state":
		return str(e.State)
	case "error":
		return str(e.Error)
	case "loginSessionId":
		return str(e.LoginSessionID)
	case "step":
		return e.Step, e.Step != nil
	case "status":
		return str(e.Status)
	case "direction":
		return str(e.Direction)
	case "more":
		return e.More, e.More != nil
	case "requestId":
		return str(e.RequestID)
	}
	return nil, false
}

// MarshalJSON writes the fields the event's type has and no others: required ones always,
// optional ones only when set. A required field that is unset is left out rather than
// written as a zero value the backend might accept; Validate catches that before an event
// is journaled, and a stored event that has it is quarantined rather than applied.
func (e Event) MarshalJSON() ([]byte, error) {
	out := map[string]any{"seq": e.Seq, "type": e.Type, "userId": e.UserID, "loginId": e.LoginID, "at": e.At}
	if e.bare {
		return json.Marshal(out)
	}
	shape := eventShapes[e.Type]
	for _, name := range shape.required {
		if value, set := e.field(name); set || writesZero(name) {
			out[name] = value
		}
	}
	for _, name := range shape.optional {
		if value, set := e.field(name); set {
			out[name] = value
		}
	}
	return json.Marshal(out)
}

// writesZero is a required field written even when unset: a string or a number, whose zero
// value still has the right type. A missing object or flag is left out instead.
func writesZero(name string) bool {
	switch name {
	case "sender", "sealed", "historical", "typing", "timeoutMs", "step", "more", "mentionsMe", "isRequest":
		return false
	}
	return true
}

// Bare is a stand-in for evt with only the fields every event has. The pusher sends it in
// place of an event too large to send, so the journal moves past it: the gateway
// quarantines it, as it would the full event, without its content.
func Bare(evt *Event) *Event {
	return &Event{Seq: evt.Seq, Type: evt.Type, UserID: evt.UserID, LoginID: evt.LoginID, At: evt.At, bare: true}
}

// ErrInvalidEvent is an event the backend would refuse. Writing it again can't succeed, so
// callers treat it as permanent rather than retrying.
var ErrInvalidEvent = errors.New("event the backend would refuse")

// ErrTooLarge is an event over one of the size limits.
var ErrTooLarge = fmt.Errorf("%w: over the protocol's size limit", ErrInvalidEvent)

// Validate checks an event before it is journaled: a known type with every field the
// backend requires, and within the size limits. An event that fails it is a bug in the
// bridge host; journaling it would only get it quarantined.
func (e *Event) Validate() error {
	shape, ok := eventShapes[e.Type]
	if !ok {
		return fmt.Errorf("%w: unknown event type %q", ErrInvalidEvent, e.Type)
	}
	if e.UserID == "" {
		return fmt.Errorf("%w: %s event has no userId", ErrInvalidEvent, e.Type)
	}
	for _, name := range shape.required {
		// A network timestamp of 0 is odd but valid; every other required field must be set.
		if _, set := e.field(name); !set && name != "networkTs" {
			return fmt.Errorf("%w: %s event is missing %s", ErrInvalidEvent, e.Type, name)
		}
	}
	if e.Sealed != nil {
		limit := MaxMessageSealedBytes
		if e.Type == EventChat || e.Type == EventContact || e.Type == EventContactIdentifiers || e.Type == EventLoginState {
			limit = MaxMetadataSealedBytes
		}
		if seal.DecodedLen(e.Sealed.CT) > limit {
			return fmt.Errorf("%s event: %w (sealed)", e.Type, ErrTooLarge)
		}
	}
	data, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidEvent, err)
	}
	if len(data) > MaxEventBytes {
		return fmt.Errorf("%s event: %w", e.Type, ErrTooLarge)
	}
	return nil
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
	// EventContactIdentifiers carries what one of the person's own logins knows a contact by.
	EventContactIdentifiers = "contactIdentifiers"
	// EventChatStarted is a startChat command's outcome: the chat, or why there is none.
	EventChatStarted  = "chatStarted"
	EventLoginState   = "loginState"
	EventLoginStep    = "loginStep"
	EventSendStatus   = "sendStatus"
	EventBackfillDone = "backfillDone"
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
	// ErrNotFound: the network has no one by that phone number, email or username.
	ErrNotFound = "not_found"
	// ErrInvalidIdentifier: what a startChat named isn't a phone number or username the
	// network takes (too few digits, say), so nobody was looked up.
	ErrInvalidIdentifier = "invalid_identifier"
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
	// AfterCancel marks a complete step for a login the person had cancelled: it connected the
	// account anyway, and they decide whether to keep it.
	AfterCancel bool `json:"afterCancel,omitempty"`
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
	// ExpiresAt (ms since the epoch) is when a QR or pairing code stops being shown. The host
	// moves it on while the code is still good, so the code from a host that went down
	// disappears instead of staying up for a scan that can't work.
	ExpiresAt int64 `json:"expiresAt,omitempty"`
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
	// Browser says the step can run in the sign-in browser; Hidden, that it runs there with
	// nobody watching (docs/architecture/signin-browser.md, Login steps).
	Browser bool `json:"browser,omitempty"`
	Hidden  bool `json:"hidden,omitempty"`
}

// MarshalJSON writes no fields as `[]`: the backend wants an array, never null.
func (c LoginCookies) MarshalJSON() ([]byte, error) {
	type plain LoginCookies
	if c.Fields == nil {
		c.Fields = []LoginCookieField{}
	}
	return json.Marshal(plain(c))
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
	// Stopping marks the last heartbeat of a host that is shutting down, so it shows offline at
	// once rather than once two minutes of missed heartbeats have passed.
	Stopping bool `json:"stopping,omitempty"`
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

	// RequestID names a startChat request, so its outcome finds it; GhostID is the contact to
	// start a chat with, when it isn't a sealed identifier.
	RequestID string `json:"requestId,omitempty"`
	GhostID   string `json:"ghostId,omitempty"`
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
	// CommandSyncContacts asks a login for its network's contact list.
	CommandSyncContacts = "syncContacts"
	// CommandStartChat opens a direct chat with a contact or a phone number, email or username.
	CommandStartChat = "startChat"
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
	// Truncated means the message was cut short to fit the sealed size limit: its
	// formatted body was dropped, and its body may end early.
	Truncated bool `json:"truncated,omitempty"`
}

type Attachment struct {
	// MediaID, Key and Nonce are empty on a Failed attachment.
	MediaID    string `json:"mediaId"`
	Mime       string `json:"mime"`
	Size       int    `json:"size"`
	Name       string `json:"name,omitempty"`
	Key        string `json:"key"`
	Nonce      string `json:"nonce"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMS int    `json:"durationMs,omitempty"`
	// Failed means the file arrived but couldn't be stored: the message keeps a record of it
	// (type, size, name) with nothing to fetch, rather than losing it without a trace.
	Failed bool `json:"failed,omitempty"`
}

// ChatPlaintext is a chat's sealed metadata.
type ChatPlaintext struct {
	Name   string      `json:"name,omitempty"`
	Topic  string      `json:"topic,omitempty"`
	Avatar *Attachment `json:"avatar,omitempty"`
	// AvatarUnchanged means the chat (or contact) has an avatar that couldn't be attached
	// this time (its upload expired). Clients keep the avatar they have.
	AvatarUnchanged bool `json:"avatarUnchanged,omitempty"`
}

// ContactPlaintext is a contact's sealed profile.
type ContactPlaintext struct {
	Name   string      `json:"name,omitempty"`
	Handle string      `json:"handle,omitempty"`
	Avatar *Attachment `json:"avatar,omitempty"`
	// AvatarUnchanged means the chat (or contact) has an avatar that couldn't be attached
	// this time (its upload expired). Clients keep the avatar they have.
	AvatarUnchanged bool `json:"avatarUnchanged,omitempty"`
}

// ContactIdentifiersPlaintext is what one of the person's own logins knows a contact by, as
// URIs (tel:+1555…, mailto:…, telegram:alice), for matching contacts to their address book.
// It's sealed apart from the profile (kind contact, object ID <ghostId>/identifiers/<loginId>)
// and sent only to that login's owner: a ghost's profile is shared by everyone on the network who
// has them as a contact, and what each login can see of a contact differs (a phone number
// in one person's address book, say).
type ContactIdentifiersPlaintext struct {
	Identifiers []string `json:"identifiers"`
}

// AccountPlaintext is what a loginState event's sealed metadata holds (kind account, object ID
// the loginId), sealed to the account's owner only: what tells the account apart from their
// others on the network, such as its phone number or username. The login ID can't: it is a
// keyed hash, so a phone number never reaches the backend readable.
type AccountPlaintext struct {
	Hint string `json:"hint,omitempty"`
}

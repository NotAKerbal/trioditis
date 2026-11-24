package connector

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/provisionutil"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// CommandError is a command refused before it ran. The server answers with its status and
// code; the detail is only logged, locally.
type CommandError struct {
	Status int
	Code   string
	Detail string
}

func (e *CommandError) Error() string { return e.Code + ": " + e.Detail }

func badRequest(format string, args ...any) error {
	return &CommandError{Status: 400, Code: protocol.ErrInvalidCommand, Detail: fmt.Sprintf(format, args...)}
}

func conflict(code, format string, args ...any) error {
	return &CommandError{Status: 409, Code: code, Detail: fmt.Sprintf(format, args...)}
}

// pendingKind is the kind of Matrix-side event waiting for bridgev2's message status.
type pendingKind int

const (
	pendingSend pendingKind = iota
	pendingEdit
	pendingReact
	pendingRedact
)

// pendingCommand is a command whose outcome bridgev2 will report through
// SendMessageStatus. A send carries the person's copy, already sealed at handoff, so the
// outcome only has to record it.
type pendingCommand struct {
	kind            pendingKind
	owner           *owner
	clientMessageID string
	targetEventID   string
	key             string
	echo            *seal.Envelope
	replyTo         string
	// lock orders the timeout and the outcome: whichever comes first is recorded first, so
	// `unknown` can never be recorded after `sent`.
	lock sync.Mutex
	// timedOut is set once the send was reported unknown for want of an outcome. The entry
	// is kept for a while after, so a late outcome is still reported.
	timedOut bool
	settled  bool
	// released is set once the chat's next command may start. A send whose handler is still
	// running inside bridgev2 never releases the chat, even once it is marked unknown.
	released bool
	// timer runs from when the event is handed to bridgev2. The chat's lane stays held until
	// bridgev2 returns, so a timeout can mark a send unknown but never lets the chat's next
	// command start while this one is still inside bridgev2 or the network.
	timer *time.Timer
	// handoffAt is when the event was handed to bridgev2, and returned whether bridgev2 has
	// finished with it. Until it has, the send may still be waiting for the chat's lock (an
	// incoming event holding it) rather than out on the network, so it isn't marked unknown
	// until it has been stuck for stuckLimit.
	handoffAt time.Time
	returned  bool
	// notAfter is a send's deadline, checked once more if the connector reads the send's
	// attachment (checkTransmitDeadline); refusedLate is set when that check refused it.
	notAfter    int64
	refusedLate bool
	// giveBack returns a send's share of the media store's budget for its file (reserveMedia)
	// once its chat is released: the connector is done with the file by then.
	giveBack func()
	// stopWait ends a wait for that share, once the chat is released: nothing is left to send.
	stopWait context.CancelFunc
}

// stuckLimit is how long, in send timeouts, a command may sit inside bridgev2 before a send
// is marked unknown anyway: with the default 3-minute send timeout, 9 minutes. The chat
// stays held after that until bridgev2 reports the outcome (its handler has finished), so no
// other command in the chat goes out alongside one that may still be transmitting, but not
// for longer than holdLimit.
const stuckLimit = 3

// holdLimit is how much longer, in send timeouts, a chat stays held by a command still inside
// bridgev2 after stuckLimit: with the default send timeout, 30 minutes more. bridgev2 doesn't
// always report an outcome (not for a chat deleted meanwhile, and not for a connector that
// never returns), so without a limit such a chat would take no commands until a restart.
// Once it is released the command is still remembered (pendingRetention), so an outcome that
// arrives later is recorded; nothing is ever sent again.
const holdLimit = 10

// target is a command's resolved user, login and portal.
type target struct {
	userMXID id.UserID
	user     *bridgev2.User
	login    *bridgev2.UserLogin
	portal   *bridgev2.Portal
	owner    *owner
}

func (c *Connector) resolve(ctx context.Context, cmd *protocol.Command, needPortal bool) (*target, error) {
	if cmd.UserID == "" {
		return nil, badRequest("userId is required")
	}
	t := &target{userMXID: ids.UserMXID(cmd.UserID)}
	var err error
	if t.user, err = c.Bridge.GetExistingUserByMXID(ctx, t.userMXID); err != nil {
		return nil, err
	} else if t.user == nil {
		return nil, conflict(protocol.ErrNotConnected, "the user has no logins on this bridge host")
	}
	if cmd.LoginID == "" {
		return nil, badRequest("loginId is required")
	}
	rawLogin, err := c.Store.LookupID(ctx, cmd.LoginID, ids.KindLogin)
	if errors.Is(err, store.ErrNotFound) {
		return nil, conflict(protocol.ErrInvalidCommand, "unknown login")
	} else if err != nil {
		return nil, err
	}
	t.login = c.Bridge.GetCachedUserLoginByID(networkid.UserLoginID(rawLogin))
	// A person can only act through their own logins.
	if t.login == nil || t.login.UserMXID != t.userMXID {
		return nil, conflict(protocol.ErrNotConnected, "login isn't connected for this user")
	}
	if !needPortal {
		return t, nil
	}
	if cmd.PortalID == "" {
		return nil, badRequest("portalId is required")
	}
	// The opaque portal ID stands for the portal's room, which keeps its ID when the network
	// re-IDs the portal (as WhatsApp does moving a chat from a phone number to a LID), so
	// the current portal is looked up by room.
	roomID, err := c.Store.LookupID(ctx, cmd.PortalID, ids.KindPortal)
	if errors.Is(err, store.ErrNotFound) {
		return nil, conflict(protocol.ErrInvalidCommand, "unknown portal")
	} else if err != nil {
		return nil, err
	}
	original, ok := ids.ParseRoomID(id.RoomID(roomID))
	if !ok || original.Receiver != t.login.ID {
		return nil, conflict(protocol.ErrInvalidCommand, "portal doesn't belong to this login")
	}
	if t.portal, err = c.Bridge.GetPortalByMXID(ctx, id.RoomID(roomID)); err != nil {
		return nil, err
	} else if t.portal == nil {
		return nil, conflict(protocol.ErrInvalidCommand, "portal doesn't exist")
	}
	if t.owner, err = c.owner(ctx, t.portal.MXID); err != nil {
		return nil, err
	}
	return t, nil
}

// checkTarget makes sure a message a command refers to (a reply, an edit, a reaction, a
// read marker) is in the command's chat. bridgev2 looks relations up by event ID alone, so
// one from another chat would otherwise reach the connector with the wrong chat's data.
func (c *Connector) checkTarget(ctx context.Context, t *target, eventID string) error {
	part, err := c.Bridge.DB.Message.GetPartByMXID(ctx, id.EventID(eventID))
	if err != nil {
		return err
	} else if part == nil || part.Room != t.portal.PortalKey {
		return conflict(protocol.ErrInvalidCommand, "the target message isn't in this chat")
	}
	return nil
}

// Prepare checks a command without running it, so the server can refuse it before storing
// it. Running it later checks again, since things may have changed in between.
func (c *Connector) Prepare(ctx context.Context, cmd *protocol.Command) error {
	return c.handle(ctx, cmd, true)
}

// HandleCommand runs a stored command. It returns once the command is handed on; outcomes
// arrive as events.
func (c *Connector) HandleCommand(ctx context.Context, cmd *protocol.Command) error {
	return c.handle(ctx, cmd, false)
}

func (c *Connector) handle(ctx context.Context, cmd *protocol.Command, check bool) error {
	switch cmd.Type {
	case protocol.CommandSend, protocol.CommandEdit:
		return c.handleSend(ctx, cmd, check)
	case protocol.CommandReact:
		return c.handleReact(ctx, cmd, check)
	case protocol.CommandUnreact, protocol.CommandRedact:
		return c.handleRedact(ctx, cmd, check)
	case protocol.CommandMarkRead:
		return c.handleMarkRead(ctx, cmd, check)
	case protocol.CommandTyping:
		return c.handleTyping(ctx, cmd, check)
	case protocol.CommandLoginStart:
		return c.handleLoginStart(ctx, cmd, check)
	case protocol.CommandLoginSubmit:
		return c.handleLoginSubmit(ctx, cmd, check)
	case protocol.CommandLoginCancel:
		return c.handleLoginCancel(ctx, cmd, check)
	case protocol.CommandLogout:
		return c.handleLogout(ctx, cmd, check)
	case protocol.CommandBackfill:
		return c.handleBackfill(ctx, cmd, check)
	case protocol.CommandSyncContacts:
		return c.handleSyncContacts(ctx, cmd, check)
	case protocol.CommandStartChat:
		return c.handleStartChat(ctx, cmd, check)
	default:
		return badRequest("unknown command type %q", cmd.Type)
	}
}

var reverseMsgTypes = func() map[string]event.MessageType {
	out := make(map[string]event.MessageType, len(msgTypes))
	for k, v := range msgTypes {
		out[v] = k
	}
	return out
}()

// matrixContent builds the Matrix message bridgev2 hands the connector from a sealed send.
// With register false it only checks the attachment, without making it readable.
func (c *Connector) matrixContent(t *target, plain *protocol.MessagePlaintext, register bool, notAfter int64) (*event.MessageEventContent, event.Type, error) {
	evtType := event.EventMessage
	content := &event.MessageEventContent{MsgType: reverseMsgTypes[plain.Type], Body: plain.Body}
	if plain.Type == "sticker" {
		evtType, content.MsgType = event.EventSticker, ""
	} else if content.MsgType == "" {
		content.MsgType = event.MsgText
	}
	if plain.HTML != "" {
		content.Format, content.FormattedBody = event.FormatHTML, plain.HTML
	}
	if len(plain.Attachments) > 1 {
		return nil, evtType, badRequest("a send carries at most one attachment")
	} else if len(plain.Attachments) == 1 {
		att := plain.Attachments[0]
		if _, ok := media.ParseContentURI(media.ContentURI(att.MediaID)); !ok {
			return nil, evtType, badRequest("invalid attachment")
		}
		if register {
			// Readable for as long as the send may still go: it can wait for others' files
			// (reserveMedia) as well as its chat, and is refused after its deadline anyway.
			ttl := max(c.SendTimeout, time.Until(time.UnixMilli(notAfter)))
			uri, err := c.Media.Register(att, t.owner.userID, ttl)
			if err != nil {
				return nil, evtType, badRequest("invalid attachment")
			}
			content.URL = uri
		}
		content.FileName = att.Name
		content.Info = &event.FileInfo{MimeType: att.Mime, Size: att.Size, Width: att.Width, Height: att.Height, Duration: att.DurationMS}
	}
	return content, evtType, nil
}

func (c *Connector) openOutbound(cmd *protocol.Command, userID, objectID string, out any) error {
	if cmd.Sealed == nil {
		return badRequest("sealed is required")
	}
	if err := seal.OpenJSON(cmd.Sealed, c.BridgeKey, seal.Context{Kind: seal.KindOutbound, OwnerUserID: userID, ObjectID: objectID}, out); err != nil {
		return badRequest("sealed content can't be opened by the bridge key")
	}
	return nil
}

// recordSend writes a send's status and the event reporting it, plus any events that go
// with it (the person's copy, on success), in one transaction: a crash can't record one
// without the other.
func (c *Connector) recordSend(ctx context.Context, o *owner, out *store.Outgoing, insert bool, extra ...*protocol.Event) error {
	statusEvent := &protocol.Event{
		Type: protocol.EventSendStatus, UserID: o.userID, LoginID: o.loginID,
		ClientMessageID: out.ClientMessageID, Status: out.Status, Error: out.Error,
	}
	if out.Status == protocol.StatusSent {
		statusEvent.EventID = out.EventID
	}
	events := append([]*protocol.Event{statusEvent}, extra...)
	now := time.Now().UnixMilli()
	for _, evt := range events {
		if evt.At == 0 {
			evt.At = now
		}
	}
	err := c.Store.Txn(ctx, func(ctx context.Context) error {
		if insert {
			inserted, err := c.Store.InsertOutgoing(ctx, out)
			if err != nil {
				return err
			} else if !inserted {
				return errAlreadyRecorded
			}
		} else if err := c.Store.SetOutgoingStatus(ctx, out.UserID, out.ClientMessageID, out.Status, out.Error); err != nil {
			return err
		}
		return c.Store.Append(ctx, events...)
	})
	if err == nil {
		c.Notify()
	}
	return err
}

var errAlreadyRecorded = errors.New("send already recorded")

// SendReconnectWait is how long bridgev2 waits for a reconnecting login before giving up on
// a send (bridgev2's config, set by the host from this).
const SendReconnectWait = 30 * time.Second

// eventHandlingLimit is how long bridgev2 lets one event hold a chat's lock: after that it
// carries on with the event in the background and lets the next one in.
var eventHandlingLimit = time.Duration(bridgev2.EventHandlingTimeoutTicks) * 30 * time.Second

// HandoffMargin is how far before its deadline a send must be handed to bridgev2.
//
// After the hand-off, a send may wait for the chat's lock behind incoming events (each holds
// it at most eventHandlingLimit, five minutes), then for a reconnecting login, before the
// network connector transmits it. For a text send neither bridgev2 nor the WhatsApp connector
// runs any code of ours in between (WhatsApp relies on its own client type, so its client
// can't be wrapped either), and the connector is called with bridgev2's own context for the
// chat, which carries no deadline of ours. The margin covers two incoming events ahead of the
// send, the reconnect wait and some slack: eleven minutes. Past the hand-off, a send can still
// go out late; see bridge-protocol.md, Deadlines.
var HandoffMargin = 2*eventHandlingLimit + SendReconnectWait + 30*time.Second

// TransmitMargin is how far before its deadline a send with an attachment must be when the
// connector reads the attachment (the last code of ours it runs before transmitting): enough
// for the upload to the network and the send after it to usually finish in time.
var TransmitMargin = 2 * time.Minute

func pastDeadline(notAfter int64) bool {
	return notAfter > 0 && time.Now().Add(HandoffMargin).UnixMilli() > notAfter
}

// reactionPastDeadline is the deadline check for a reaction or its removal. The backend gives
// a reaction ten minutes (messages.react), less than HandoffMargin, which is sized for a send
// that may wait behind the chat's lock: with that margin every reaction was refused as soon as
// it arrived. So a reaction is refused only once its deadline has passed. One handed to bridgev2
// just before can still wait on the chat's lock and go out after it; its echo then updates the
// chat, and a late reaction does far less harm than a late message.
func reactionPastDeadline(notAfter int64) bool {
	return notAfter > 0 && time.Now().UnixMilli() > notAfter
}

// errTransmitDeadline is an attachment read refused because its send is past its deadline.
var errTransmitDeadline = errors.New("the send is past its deadline")

// checkTransmitDeadline runs when a connector reads media while handling a Matrix event: for
// a send with an attachment, that happens after bridgev2 has taken the chat's lock and before
// the connector uploads and transmits. A send whose deadline has come close by then is
// refused there, so it doesn't go out late. The connector can't send media it couldn't read
// (WhatsApp ends the conversion with an error), so the send then fails as expired.
func (c *Connector) checkTransmitDeadline(ctx context.Context) error {
	evt := bridgev2.GetMatrixEventFromContext(ctx)
	if evt == nil {
		return nil
	}
	raw, ok := c.pending.Load(evt.ID)
	if !ok {
		return nil
	}
	pending := raw.(*pendingCommand)
	if pending.kind != pendingSend && pending.kind != pendingEdit {
		return nil
	}
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.notAfter <= 0 || time.Now().Add(TransmitMargin).UnixMilli() <= pending.notAfter {
		return nil
	}
	pending.refusedLate = true
	return errTransmitDeadline
}

// reserveMedia waits for a send's file to have its share of the media store's budget, just
// before the connector reads it, and keeps the share with the send until its chat is released.
// Then it checks the deadline once more, since the wait may have been long.
func (c *Connector) reserveMedia(ctx context.Context, uri id.ContentURIString) error {
	evt := bridgev2.GetMatrixEventFromContext(ctx)
	if evt == nil {
		return nil
	}
	raw, ok := c.pending.Load(evt.ID)
	if !ok {
		return nil
	}
	pending := raw.(*pendingCommand)
	if pending.kind != pendingSend && pending.kind != pendingEdit {
		return nil
	}
	// The wait ends when the send could no longer go (TransmitMargin before its deadline), or
	// its chat is released.
	wait, stop := context.WithCancel(ctx)
	defer stop()
	if pending.notAfter > 0 {
		var stopDeadline context.CancelFunc
		wait, stopDeadline = context.WithDeadline(wait, time.UnixMilli(pending.notAfter).Add(-TransmitMargin))
		defer stopDeadline()
	}
	pending.lock.Lock()
	if pending.released {
		pending.lock.Unlock()
		return errTransmitDeadline
	}
	pending.stopWait = stop
	pending.lock.Unlock()
	giveBack, err := c.Media.Reserve(wait, uri)
	if err != nil {
		if ctx.Err() == nil {
			// Not this caller giving up: the send waited until it could no longer go.
			pending.lock.Lock()
			pending.refusedLate = true
			pending.lock.Unlock()
			return errTransmitDeadline
		}
		return err
	}
	pending.lock.Lock()
	pending.stopWait = nil
	if pending.released {
		// Given up on while it waited: nothing is left to give it back later. Its file is
		// never read, so it never went.
		pending.refusedLate = true
		pending.lock.Unlock()
		giveBack()
		return errTransmitDeadline
	}
	if pending.giveBack != nil {
		pending.giveBack()
	}
	pending.giveBack = giveBack
	pending.lock.Unlock()
	return c.checkTransmitDeadline(ctx)
}

func (c *Connector) handleSend(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.ClientMessageID == "" {
		return badRequest("clientMessageId is required")
	}
	// A send without a deadline could go out at any time later; every send has one.
	if cmd.Type == protocol.CommandSend && cmd.NotAfter <= 0 {
		return badRequest("notAfter is required")
	}
	// A client seals at most 64 KiB into a send (the backend refuses more), so a bigger one
	// didn't come from a client's outbox. It is refused before it can reach the network:
	// the person's sealed copy of it couldn't be journaled.
	if cmd.Sealed != nil && seal.DecodedLen(cmd.Sealed.CT) > protocol.MaxClientSealedBytes {
		return badRequest("sealed is over %d bytes", protocol.MaxClientSealedBytes)
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	var plain protocol.MessagePlaintext
	if err = c.openOutbound(cmd, cmd.UserID, cmd.ClientMessageID, &plain); err != nil {
		return err
	}
	if cmd.Type == protocol.CommandEdit {
		if cmd.TargetEventID == "" {
			return badRequest("targetEventId is required")
		}
		if err = c.checkTarget(ctx, t, cmd.TargetEventID); err != nil {
			return err
		}
	} else if cmd.ReplyTo != "" {
		if err = c.checkTarget(ctx, t, cmd.ReplyTo); err != nil {
			return err
		}
	}
	if check {
		_, _, err = c.matrixContent(t, &plain, false, cmd.NotAfter)
		return err
	}

	// A repeated send is never sent again: the last known status is repeated instead.
	if existing, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); err == nil {
		return c.emitSendStatus(ctx, t.owner, existing.ClientMessageID, existing.Status, existing.EventID, existing.Error)
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	eventID := ids.OutgoingEventID(cmd.UserID, cmd.ClientMessageID)
	out := &store.Outgoing{UserID: cmd.UserID, LoginID: t.owner.loginID, ClientMessageID: cmd.ClientMessageID, EventID: string(eventID)}
	// A send that waited too long (behind an earlier send in the chat, say) doesn't go out,
	// and the person decides. Checked again right before the hand-off, below.
	if pastDeadline(cmd.NotAfter) {
		out.Status, out.Error = protocol.StatusFailed, protocol.ErrExpired
		if err = c.recordSend(ctx, t.owner, out, true); errors.Is(err, errAlreadyRecorded) {
			return nil
		}
		return err
	}
	content, evtType, err := c.matrixContent(t, &plain, true, cmd.NotAfter)
	if err != nil {
		return err
	}
	pending := &pendingCommand{kind: pendingSend, owner: t.owner, clientMessageID: cmd.ClientMessageID, notAfter: cmd.NotAfter}
	if cmd.Type == protocol.CommandEdit {
		pending.kind, pending.targetEventID = pendingEdit, cmd.TargetEventID
		edit := *content
		content = &event.MessageEventContent{MsgType: edit.MsgType, Body: "* " + edit.Body, NewContent: &edit}
		content.SetEdit(id.EventID(cmd.TargetEventID))
	} else if cmd.ReplyTo != "" {
		pending.replyTo = cmd.ReplyTo
		content.RelatesTo = (&event.RelatesTo{}).SetReplyTo(id.EventID(cmd.ReplyTo))
	}
	// The person's copy is sealed now, while the plaintext is in hand, and recorded with
	// the `sent` outcome. Then the plaintext is dropped. It is fitted like an incoming
	// message, so the outcome can always be journaled.
	echo := plain
	echo.Attachments = slices.Clone(plain.Attachments)
	if pending.echo, err = c.seal(ctx, t.owner, seal.KindMessage, string(eventID), fitMessage(&echo)); err != nil {
		return err
	}
	out.Status = protocol.StatusSubmitted
	if err = c.recordSend(ctx, t.owner, out, true); errors.Is(err, errAlreadyRecorded) {
		// Raced with the same send: the other run owns it.
		return nil
	} else if err != nil {
		return err
	}
	c.trackPending(eventID, pending)
	c.startTimeout(eventID, pending)
	// The last point before bridgev2 has it: sealing and recording took time (a key fetch, a
	// database write), so the deadline is checked again, as the last thing before the
	// hand-off.
	if pastDeadline(cmd.NotAfter) {
		c.stopTimer(pending)
		c.settle(ctx, eventID, pending, protocol.StatusFailed, protocol.ErrExpired)
		return nil
	}
	res := c.queue(ctx, t, &event.Event{Type: evtType, ID: eventID, Content: event.Content{Parsed: content}})
	c.handedOff(ctx, eventID, pending, res)
	return nil
}

func (c *Connector) handleReact(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.TargetEventID == "" || cmd.Key == "" {
		return badRequest("targetEventId and key are required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	if err = c.checkTarget(ctx, t, cmd.TargetEventID); err != nil {
		return err
	}
	// A reaction that waited past its deadline (behind a send in the chat, say) isn't sent:
	// it would turn up long after the person chose it.
	if reactionPastDeadline(cmd.NotAfter) {
		return conflict(protocol.ErrExpired, "the reaction is past its deadline")
	} else if check {
		return nil
	}
	eventID := ids.CommandEventID(cmd.UserID, cmd.CommandID)
	pending := &pendingCommand{kind: pendingReact, owner: t.owner, targetEventID: cmd.TargetEventID, key: reactionKey(cmd.Key)}
	c.trackPending(eventID, pending)
	c.startTimeout(eventID, pending)
	res := c.queue(ctx, t, &event.Event{
		Type: event.EventReaction, ID: eventID,
		Content: event.Content{Parsed: &event.ReactionEventContent{RelatesTo: event.RelatesTo{
			Type: event.RelAnnotation, EventID: id.EventID(cmd.TargetEventID), Key: cmd.Key,
		}}},
	})
	c.handedOff(ctx, eventID, pending, res)
	return nil
}

func (c *Connector) handleRedact(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.TargetEventID == "" {
		return badRequest("targetEventId is required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	if err = c.checkTarget(ctx, t, cmd.TargetEventID); err != nil {
		return err
	}
	redacts := id.EventID(cmd.TargetEventID)
	// A successful unreact is reported as reactionRemove, which the key distinguishes.
	pending := &pendingCommand{kind: pendingRedact, owner: t.owner, targetEventID: cmd.TargetEventID}
	if cmd.Type == protocol.CommandUnreact {
		if cmd.Key == "" {
			return badRequest("key is required")
		}
		if redacts, err = c.ownReaction(ctx, t, redacts, cmd.Key); err != nil {
			return err
		}
		pending.key = reactionKey(cmd.Key)
	}
	if cmd.Type == protocol.CommandUnreact && reactionPastDeadline(cmd.NotAfter) {
		return conflict(protocol.ErrExpired, "the reaction is past its deadline")
	} else if check {
		return nil
	}
	eventID := ids.CommandEventID(cmd.UserID, cmd.CommandID)
	c.trackPending(eventID, pending)
	c.startTimeout(eventID, pending)
	res := c.queue(ctx, t, &event.Event{
		Type: event.EventRedaction, ID: eventID, Redacts: redacts,
		Content: event.Content{Parsed: &event.RedactionEventContent{Redacts: redacts}},
	})
	c.handedOff(ctx, eventID, pending, res)
	return nil
}

// ownReaction finds the Matrix ID of the person's own reaction with key on a message.
// bridgev2 doesn't always store the emoji itself, so the key comes from the bridge host's
// reaction index.
func (c *Connector) ownReaction(ctx context.Context, t *target, target id.EventID, key string) (id.EventID, error) {
	part, err := c.Bridge.DB.Message.GetPartByMXID(ctx, target)
	if err != nil {
		return "", err
	} else if part == nil {
		return "", conflict(protocol.ErrInvalidCommand, "unknown target message")
	}
	reactions, err := c.Bridge.DB.Reaction.GetAllToMessage(ctx, t.login.ID, part.ID)
	if err != nil {
		return "", err
	}
	for _, reaction := range reactions {
		if reaction.SenderMXID != t.userMXID && !t.login.Client.IsThisUser(ctx, reaction.SenderID) {
			continue
		}
		_, indexed, err := c.Store.GetReaction(ctx, string(reaction.MXID))
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
		if indexed == reactionKey(key) || reactionKey(reaction.Emoji) == reactionKey(key) {
			return reaction.MXID, nil
		}
	}
	return "", conflict(protocol.ErrInvalidCommand, "no reaction with that key from this user")
}

func (c *Connector) handleMarkRead(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.UpToEventID == "" {
		return badRequest("upToEventId is required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	if err = c.checkTarget(ctx, t, cmd.UpToEventID); err != nil || check {
		return err
	}
	evt := &event.Event{
		Type: event.EphemeralEventReceipt, RoomID: t.portal.MXID,
		Content: event.Content{Parsed: &event.ReceiptEventContent{
			id.EventID(cmd.UpToEventID): {event.ReceiptTypeRead: {t.userMXID: {Timestamp: time.Now()}}},
		}},
	}
	evt.Mautrix.EventSource = event.SourceEphemeral
	c.Bridge.QueueMatrixEvent(c.Bridge.BackgroundCtx, evt)
	return nil
}

func (c *Connector) handleTyping(ctx context.Context, cmd *protocol.Command, check bool) error {
	t, err := c.resolve(ctx, cmd, true)
	if err != nil || check {
		return err
	}
	var typing []id.UserID
	if cmd.Typing {
		typing = []id.UserID{t.userMXID}
	}
	evt := &event.Event{
		Type: event.EphemeralEventTyping, RoomID: t.portal.MXID,
		Content: event.Content{Parsed: &event.TypingEventContent{UserIDs: typing}},
	}
	evt.Mautrix.EventSource = event.SourceEphemeral
	c.Bridge.QueueMatrixEvent(c.Bridge.BackgroundCtx, evt)
	return nil
}

func (c *Connector) handleLogout(ctx context.Context, cmd *protocol.Command, check bool) error {
	t, err := c.resolve(ctx, cmd, false)
	if err != nil || check {
		return err
	}
	go t.login.Logout(c.Bridge.BackgroundCtx)
	return nil
}

// numberIDNetworks are the networks where a contact's ID can be their phone number (on
// WhatsApp, a contact who isn't hidden behind a LID), which the person's own chats with them
// carry. testnet is the conformance tests' connector.
//
// Networks' own contact lists aren't used: each connector's reaches past the login that asks.
// mautrix-telegram's changes the ghost every member shares and stores numbers in a shared
// table, mautrix-whatsapp's fills numbers in from a map every login on the host shares,
// mautrix-signal's adds a username from the shared ghost, and mautrix-gmessages's logs
// numbers. Using them needs those connectors patched first.
var numberIDNetworks = map[string]bool{"whatsapp": true, "testnet": true}

// handleSyncContacts sends, for each contact the login has a chat with whose ID is their
// phone number, that number, to the login's owner only. It runs in the background, and the
// numbers arrive as contactIdentifiers events.
func (c *Connector) handleSyncContacts(ctx context.Context, cmd *protocol.Command, check bool) error {
	if !numberIDNetworks[c.Network] {
		return conflict(protocol.ErrUnsupported, "the network's contact IDs aren't phone numbers")
	}
	t, err := c.resolve(ctx, cmd, false)
	if err != nil || check {
		return err
	}
	o := &owner{userID: cmd.UserID, login: t.login.ID, loginID: cmd.LoginID}
	go func() {
		if err := c.syncNumbers(c.Bridge.BackgroundCtx, o); err != nil {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Syncing a login's contact numbers failed")
		}
	}()
	return nil
}

// startChatPlaintext is what a client seals for a startChat command with an identifier.
type startChatPlaintext struct {
	Identifier string `json:"identifier"`
}

// requestIDPattern is what a startChat request ID may be: what clients pick for their IDs.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// maxIdentifierBytes bounds the phone number or username a startChat names.
const maxIdentifierBytes = 512

// startTargets is what a startChat can start a chat from on each network, per its connector:
// one of the person's contacts there, a phone number, or a username. Each was audited:
// mautrix-telegram's identifier lookup reads a phone table every login on the host shares, and
// mautrix-gvoice's portal keys (which bridgev2 logs) are phone numbers, so neither starts from
// an identifier (Google Voice not at all); mautrix-meta's resolves only numeric IDs, so
// Messenger and Instagram start from contacts; mautrix-twitter's resolves screen names, not
// the numeric IDs contacts have, so X starts from a username. WhatsApp and Google Messages
// take only phone numbers: mautrix-whatsapp also resolves a LID, and fills in its phone number
// from a map every login on the host shares. testnet is the conformance tests' connector.
var startTargets = map[string]struct{ contact, phone, username bool }{
	"whatsapp":  {contact: true, phone: true},
	"signal":    {contact: true, phone: true, username: true},
	"gmessages": {contact: true, phone: true},
	"telegram":  {contact: true},
	"meta":      {contact: true},
	"instagram": {contact: true},
	"slack":     {contact: true},
	"linkedin":  {contact: true},
	"twitter":   {username: true},
	"testnet":   {contact: true, phone: true, username: true},
}

// A phone number is 7 to 15 digits once its formatting is taken off (E.164 allows at most 15).
const (
	minPhoneDigits = 7
	maxPhoneDigits = 15
)

// Phone numbers are read exactly as the client reads them before sending one
// (packages/core/src/people.ts, normalPhone and startIdentifier), so a number the app offers is
// one the host takes. Both are checked against the same table of cases,
// packages/core/test/fixtures/phone-identifiers.json.
var (
	phoneScheme = regexp.MustCompile(`(?i)^(?:tel|sms):`)
	// From an extension on ("x12", "ext. 12", "#12", ";ext=12") is dropped.
	phoneExtension = regexp.MustCompile(`(?i)[;,#]|\s*(?:x|ext\.?|extension)\s*\d`)
	// "+44 (0)20 …", "0044 (0)20 …": the bracketed trunk 0 isn't dialled with the country code.
	phoneTrunkZero = regexp.MustCompile(`^((?:\+|00)\s*\d{1,3})[\s\x{00a0}]*\(0\)`)
	// Letters, an @ or an underscore make it a username; otherwise it was meant as a number.
	usernameish       = regexp.MustCompile(`(?i)[a-z@_]`)
	trailingExtension = regexp.MustCompile(`(?i)\s*(?:x|ext\.?|extension)\s*\d+$`)
	onlyDigits        = regexp.MustCompile(`^[0-9]+$`)
)

// phonePunctuation is what people write between a number's digits: spaces of every width,
// dots, slashes, brackets and dashes of every length.
func phonePunctuation(r rune) bool {
	switch {
	case unicode.IsSpace(r), r >= '\u2000' && r <= '\u200b', r == '\u202f', r == '\ufeff',
		r == '.', r == '/', r == '(', r == ')', r == '-', r >= '\u2010' && r <= '\u2015', r == '\u2212':
		return true
	}
	return false
}

// normalPhone is a typed number as + and its digits, or its national digits as written; ""
// if it isn't a number. A scheme (tel:, sms:) and an extension are dropped, then the
// punctuation; a leading 00 is the international prefix, taken as +. A national number keeps
// its trunk 0: which country it belongs to can't be told from it.
func normalPhone(raw string) string {
	text := phoneScheme.ReplaceAllString(strings.TrimSpace(raw), "")
	if loc := phoneExtension.FindStringIndex(text); loc != nil {
		text = text[:loc[0]]
	}
	text = phoneTrunkZero.ReplaceAllString(strings.TrimSpace(text), "$1")
	plus := strings.HasPrefix(text, "+")
	digits := strings.Map(func(r rune) rune {
		if phonePunctuation(r) {
			return -1
		}
		return r
	}, strings.TrimPrefix(text, "+"))
	if !onlyDigits.MatchString(digits) {
		return ""
	}
	international := plus
	if !plus && strings.HasPrefix(digits, "00") {
		digits, international = digits[2:], true
	}
	if len(digits) < minPhoneDigits || len(digits) > maxPhoneDigits {
		return ""
	}
	if international {
		// No country code starts with 0.
		if strings.HasPrefix(digits, "0") {
			return ""
		}
		return "+" + digits
	}
	return digits
}

// usernamePatterns are each network's own username grammar, after a leading @ is taken off:
// anything else could be an internal ID the connector resolves another way (a Signal ACI, say).
var usernamePatterns = map[string]*regexp.Regexp{
	"signal":  regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{2,31}\.[0-9]{2,9}$`),
	"twitter": regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`),
	"testnet": regexp.MustCompile(`^[a-z][a-z0-9-]*$`),
}

// internationalOnly are the networks that take a phone number only with its country code.
var internationalOnly = map[string]bool{"signal": true}

// countryCodeFirst are the networks that read a number without + as international anyway
// (mautrix-whatsapp prefixes the digits with +). A number starting with 0 there is written the
// national way, since no country code starts with 0: looking it up would ask about a different
// number, so it is refused as written wrong.
var countryCodeFirst = map[string]bool{"whatsapp": true}

// canonicalIdentifier is the identifier as the network's connector gets it: a phone number as
// digits with its leading + (never dots or spaces, which a connector could take for one of its
// own IDs, as mautrix-gmessages does), or a username without its @. Empty if it's neither kind
// the network takes; the person is told it isn't written in a way the network takes
// (invalid_identifier), as against nobody on the network having it (not_found), which only
// the network can say.
func (c *Connector) canonicalIdentifier(identifier string) string {
	targets := startTargets[c.Network]
	text := strings.TrimSpace(identifier)
	// A valid number is one, extension and all (";ext=89" has letters); otherwise letters, an @ or
	// an underscore make it a username. The client decides the same way (startIdentifier).
	meantAsNumber := normalPhone(text) != "" || !usernameish.MatchString(trailingExtension.ReplaceAllString(phoneScheme.ReplaceAllString(text, ""), ""))
	switch {
	case meantAsNumber && !targets.phone && targets.username && onlyDigits.MatchString(text):
		// Digits alone can be a username where only usernames work (X allows it).
	case meantAsNumber && !targets.phone:
		return ""
	case meantAsNumber:
		phone := normalPhone(text)
		national := !strings.HasPrefix(phone, "+")
		if phone == "" || national && internationalOnly[c.Network] || national && countryCodeFirst[c.Network] && strings.HasPrefix(phone, "0") {
			return ""
		}
		return phone
	}
	if pattern := usernamePatterns[c.Network]; targets.username && pattern != nil {
		if name := strings.TrimPrefix(text, "@"); pattern.MatchString(name) {
			return name
		}
	}
	return ""
}

// startChatTimeout bounds how long a network has to find someone and open the chat.
const startChatTimeout = 2 * time.Minute

// handleStartChat opens a direct chat on a login: with one of the person's contacts
// (ghostId), or with whoever a sealed phone number or username belongs to, where the
// network's connector can (startTargets). An existing chat is returned as it is. bridgev2's
// provisioning helper does the work, as a Matrix client's "start a DM" would; the outcome is
// a chatStarted event. One login's starts run one at a time, so two for the same new chat
// don't both create it.
func (c *Connector) handleStartChat(ctx context.Context, cmd *protocol.Command, check bool) error {
	if !requestIDPattern.MatchString(cmd.RequestID) {
		return badRequest("requestId is required")
	}
	if (cmd.GhostID == "") == (cmd.Sealed == nil) {
		return badRequest("give either ghostId or a sealed identifier")
	}
	targets := startTargets[c.Network]
	if (cmd.GhostID != "" && !targets.contact) || (cmd.Sealed != nil && !targets.phone && !targets.username) {
		return conflict(protocol.ErrUnsupported, "the network can't start chats that way")
	}
	t, err := c.resolve(ctx, cmd, false)
	if err != nil {
		return err
	}
	if _, ok := t.login.Client.(bridgev2.IdentifierResolvingNetworkAPI); !ok {
		return conflict(protocol.ErrUnsupported, "the network can't start chats")
	}
	var identifier string
	if cmd.GhostID != "" {
		raw, err := c.Store.LookupID(ctx, cmd.GhostID, ids.KindGhost)
		if err != nil {
			return err
		} else if raw == "" {
			return conflict(protocol.ErrInvalidCommand, "unknown ghost")
		}
		// The helper takes a ghost's Matrix ID as "this user", and starts a chat with them
		// directly where the connector can.
		identifier = string(ids.GhostMXID(networkid.UserID(raw)))
	} else {
		var plain startChatPlaintext
		if err := c.openOutbound(cmd, cmd.UserID, cmd.RequestID, &plain); err != nil {
			return err
		}
		identifier = strings.TrimSpace(plain.Identifier)
		if identifier == "" || len(identifier) > maxIdentifierBytes {
			return badRequest("the identifier is empty or too long")
		}
		// Only the kinds the network's connector resolves safely; anything else is nobody here.
		if identifier = c.canonicalIdentifier(identifier); identifier == "" {
			return conflict(protocol.ErrInvalidIdentifier, "that isn't a phone number or username the network takes")
		}
	}
	if check {
		return nil
	}
	o := &owner{userID: cmd.UserID, login: t.login.ID, loginID: cmd.LoginID}
	login := t.login
	go func() {
		bgCtx := c.Bridge.BackgroundCtx
		evt := &protocol.Event{Type: protocol.EventChatStarted, UserID: o.userID, LoginID: o.loginID, RequestID: cmd.RequestID}
		lock, _ := c.starting.LoadOrStore(login.ID, &sync.Mutex{})
		lock.(*sync.Mutex).Lock()
		defer lock.(*sync.Mutex).Unlock()
		// The backend gave up on it at the deadline (a host that stopped after taking it, say),
		// so it isn't started late, after the person was told it didn't.
		if cmd.NotAfter > 0 && time.Now().UnixMilli() > cmd.NotAfter {
			evt.Error = protocol.ErrExpired
		} else {
			evt.PortalID, evt.Error = c.startChat(bgCtx, login, identifier)
		}
		if err := c.emit(bgCtx, evt); err != nil {
			c.Log.Err(err).Msg("Reporting a started chat failed")
		}
	}()
	return nil
}

// startChat finds who an identifier (or a ghost's Matrix ID) is and opens the direct chat with
// them, returning its portal ID or an error code. The connectors and bridgev2 log as they go,
// and what they log can include the identifier (a number nobody has, a portal key that is a
// phone number), so their logging is silenced for it.
func (c *Connector) startChat(bgCtx context.Context, login *bridgev2.UserLogin, identifier string) (string, string) {
	ctx, cancel := context.WithTimeout(zerolog.Nop().WithContext(bgCtx), startChatTimeout)
	defer cancel()
	resp, err := provisionutil.ResolveIdentifier(ctx, login, identifier, true)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "", protocol.ErrTimeout
	case err != nil:
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Starting a chat failed")
		return "", startChatErrorCode(err)
	case resp == nil || resp.Portal == nil || resp.Portal.MXID == "":
		return "", protocol.ErrNotFound
	}
	portalID, err := c.portalOpaqueForRoom(bgCtx, resp.Portal.MXID)
	if err != nil {
		c.Log.Err(err).Msg("Naming a started chat failed")
		return "", protocol.ErrInternal
	}
	return portalID, ""
}

// startChatErrorCode is the code for why a chat couldn't be started. Connectors answer an
// identifier nobody has with a Matrix "not found" (or a bad parameter, for one that can't be a
// number or username at all).
func startChatErrorCode(err error) string {
	if errors.Is(err, bridgev2.ErrNotLoggedIn) {
		return protocol.ErrNotConnected
	}
	// Connectors return mautrix's error type, and bridgev2 its own copy of it.
	var code string
	var matrixErr mautrix.RespError
	var bridgeErr bridgev2.RespError
	if errors.As(err, &matrixErr) {
		code = matrixErr.ErrCode
	} else if errors.As(err, &bridgeErr) {
		code = bridgeErr.ErrCode
	}
	switch code {
	case mautrix.MNotFound.ErrCode, mautrix.MInvalidParam.ErrCode:
		return protocol.ErrNotFound
	case mautrix.MUnrecognized.ErrCode:
		return protocol.ErrUnsupported
	case mautrix.MLimitExceeded.ErrCode:
		return protocol.ErrRateLimited
	default:
		return protocol.ErrNetworkRejected
	}
}

// maxBackfillLimit bounds one backfill command.
const maxBackfillLimit = 500

// prunesOnBackfill are networks whose connector deletes stored history outside the range an
// explicit backfill asked for (mautrix-whatsapp backfill.go, FetchMessages).
var prunesOnBackfill = map[string]bool{"whatsapp": true}

// handleBackfill fetches up to limit messages before beforeEventId (or before the oldest
// bridged message) and imports them, then reports whether the network has more.
func (c *Connector) handleBackfill(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.Limit <= 0 || cmd.Limit > maxBackfillLimit {
		return badRequest("limit must be between 1 and %d", maxBackfillLimit)
	}
	// Some connectors prune their stored history on any backward fetch: WhatsApp treats an
	// empty result for the requested range as the end of history and deletes every cached
	// history row for the chat, including newer ones not imported yet. Their history comes
	// in through bridgev2's own backfill instead, and an explicit fetch isn't offered.
	if prunesOnBackfill[c.Network] {
		return conflict(protocol.ErrUnsupported, "this network can't fetch a range of history on request")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	api, ok := t.login.Client.(bridgev2.BackfillingNetworkAPI)
	if !ok {
		return conflict(protocol.ErrUnsupported, "the network can't fetch history")
	}
	var anchor *database.Message
	if cmd.BeforeEventID != "" {
		if err = c.checkTarget(ctx, t, cmd.BeforeEventID); err != nil {
			return err
		}
		if anchor, err = c.Bridge.DB.Message.GetPartByMXID(ctx, id.EventID(cmd.BeforeEventID)); err != nil {
			return err
		}
	} else if anchor, err = c.Bridge.DB.Message.GetFirstPortalMessage(ctx, t.portal.PortalKey); err != nil {
		return err
	}
	if check {
		return nil
	}
	o := t.owner
	go func() {
		bgCtx := c.Bridge.BackgroundCtx
		more := false
		resp, err := api.FetchMessages(bgCtx, bridgev2.FetchMessagesParams{
			// A slow fetch (asking the phone for more) is what lets `more: true` be followed.
			Portal: t.portal, AnchorMessage: anchor, Count: cmd.Limit, Forward: false, AllowSlowFetch: true,
		})
		done := func(err error) {
			if err != nil {
				c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Backfill failed")
			}
			if emitErr := c.emit(bgCtx, &protocol.Event{
				Type: protocol.EventBackfillDone, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID,
				Direction: "backward", More: &more,
			}); emitErr != nil {
				c.Log.Err(emitErr).Msg("Failed to record backfill completion")
			}
		}
		if err != nil {
			done(err)
			return
		}
		more = resp.HasMore
		c.Bridge.WakeupBackfillQueue(&bridgev2.ManualBackfill{Source: t.login, Portal: t.portal, Data: resp, DoneCallback: done})
	}()
	return nil
}

// queue hands a Matrix-side event to bridgev2 as if a homeserver had delivered it. bridgev2
// handles a chat's events synchronously (PortalEventBuffer 0), so this returns once the
// connector has handled it: it runs on the chat's lane, never on the worker.
func (c *Connector) queue(ctx context.Context, t *target, evt *event.Event) bridgev2.EventHandlingResult {
	evt.Sender = t.userMXID
	evt.RoomID = t.portal.MXID
	evt.Timestamp = time.Now().UnixMilli()
	evt.Mautrix.EventSource = event.SourceTimeline
	res := c.Bridge.QueueMatrixEvent(c.Bridge.BackgroundCtx, evt)
	if !res.Success && !res.Queued {
		c.Log.Warn().Str("error_type", errorType(res.Error)).Stringer("event_id", evt.ID).Msg("bridgev2 refused a command's event")
	}
	return res
}

func errorType(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}

// startTimeout starts the wait for a command's outcome, as it is handed to bridgev2.
func (c *Connector) startTimeout(eventID id.EventID, pending *pendingCommand) {
	pending.lock.Lock()
	defer pending.lock.Unlock()
	pending.handoffAt = time.Now()
	pending.timer = time.AfterFunc(c.SendTimeout, func() { c.expirePending(eventID) })
}

func (c *Connector) stopTimer(pending *pendingCommand) {
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.timer != nil {
		pending.timer.Stop()
	}
}

func isSendKind(kind pendingKind) bool { return kind == pendingSend || kind == pendingEdit }

// handedOff runs once bridgev2 has finished with a command's event. If it reported no
// outcome and didn't take the event, nothing reached the network: a send fails.
func (c *Connector) handedOff(ctx context.Context, eventID id.EventID, pending *pendingCommand, res bridgev2.EventHandlingResult) {
	// bridgev2 gives up waiting on a handler after five minutes and returns while it carries on
	// in the background. That command (a send, or a reaction or redaction, which the network
	// may also be slow to take) is still inside the network connector: it has not returned,
	// and only its outcome (SendMessageStatus) says it has finished. The chat stays held so
	// the chat's next command can't overtake it, up to holdLimit.
	if errors.Is(res.Error, bridgev2.ErrHandlerBackgrounded) {
		c.Log.Warn().Stringer("event_id", eventID).Msg("A command is still being handled after bridgev2 stopped waiting; its chat stays held")
		return
	}
	pending.lock.Lock()
	pending.returned = true
	open := !pending.settled && !pending.timedOut
	if open && pending.timer != nil && (res.Success || res.Queued) {
		if isSendKind(pending.kind) {
			// The connector has it now; the wait for an outcome it reports later (a remote echo)
			// starts afresh.
			pending.timer.Stop()
			pending.timer = time.AfterFunc(c.SendTimeout, func() { c.expirePending(eventID) })
		} else {
			// A reaction or redaction is finished once its handler is: bridgev2 reports its
			// outcome before returning. The chat goes on; the entry stays until its timer, in
			// case the outcome is still being recorded.
			c.release(eventID, pending)
		}
	}
	if pending.timedOut && !pending.settled && !pending.released {
		// Marked unknown while still inside bridgev2, and now its handler is done: bridgev2
		// reports any outcome before that, so nothing else from it can go out. The chat goes
		// on, and a late outcome is still recorded until pendingRetention.
		c.releaseForRetention(eventID, pending)
	}
	pending.lock.Unlock()
	if open && !res.Success && !res.Queued {
		pending.lock.Lock()
		if pending.timer != nil {
			pending.timer.Stop()
		}
		pending.lock.Unlock()
		c.settle(ctx, eventID, pending, protocol.StatusFailed, protocol.ErrInternal)
	}
}

// settle ends a command's wait with an outcome decided here (it expired, or bridgev2 didn't
// take it), records it and lets the chat go on.
func (c *Connector) settle(ctx context.Context, eventID id.EventID, pending *pendingCommand, status, code string) {
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.settled {
		return
	}
	if isSendKind(pending.kind) {
		out := &store.Outgoing{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, ClientMessageID: pending.clientMessageID,
			Status: status, Error: code,
		}
		if err := c.recordUntilCommitted(func(ctx context.Context) error { return c.recordSend(ctx, pending.owner, out, false) }); isPermanent(err) {
			c.Log.Error().Str("code", "invalid_event").Stringer("event_id", eventID).Msg("A send's outcome can't be recorded; releasing its chat anyway")
		} else if err != nil {
			c.Log.Err(err).Stringer("event_id", eventID).Msg("Failed to record a send's outcome")
			return
		}
	}
	pending.settled = true
	c.pending.CompareAndDelete(eventID, pending)
	c.release(eventID, pending)
}

// pendingRetention is how long a command is remembered after its chat is released without
// an outcome, so an outcome that arrives late is still reported.
const pendingRetention = time.Hour

// trackPending records a command handed to bridgev2 and holds its chat until it settles.
func (c *Connector) trackPending(eventID id.EventID, pending *pendingCommand) {
	c.busy.Store(pending.owner.portalID, eventID)
	c.pending.Store(eventID, pending)
}

// release lets the next command for a chat go. The caller holds pending.lock.
func (c *Connector) release(eventID id.EventID, pending *pendingCommand) {
	if pending.released {
		return
	}
	pending.released = true
	if pending.giveBack != nil {
		pending.giveBack()
		pending.giveBack = nil
	}
	if pending.stopWait != nil {
		pending.stopWait()
		pending.stopWait = nil
	}
	c.busy.CompareAndDelete(pending.owner.portalID, eventID)
	c.wakeWorker()
}

// releaseForRetention releases the chat of a command that has no outcome yet and keeps the
// command for pendingRetention, so a late outcome is still recorded. The caller holds
// pending.lock.
func (c *Connector) releaseForRetention(eventID id.EventID, pending *pendingCommand) {
	c.release(eventID, pending)
	if pending.timer != nil {
		pending.timer.Stop()
	}
	pending.timer = time.AfterFunc(pendingRetention, func() { c.pending.CompareAndDelete(eventID, pending) })
}

// expirePending runs when bridgev2 hasn't reported a command's outcome in time. A send is
// marked unknown. Nothing is forgotten: if bridgev2 does report later, that outcome is
// recorded too.
func (c *Connector) expirePending(eventID id.EventID) {
	raw, ok := c.pending.Load(eventID)
	if !ok {
		return
	}
	pending := raw.(*pendingCommand)
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.settled {
		c.pending.CompareAndDelete(eventID, pending)
		return
	} else if pending.timedOut {
		return
	}
	// Still inside bridgev2: possibly not started yet, so not unknown yet either. The chat's
	// lane is held meanwhile, so nothing else in the chat goes out.
	if !pending.returned && time.Since(pending.handoffAt) < stuckLimit*c.SendTimeout {
		pending.timer = time.AfterFunc(c.SendTimeout, func() { c.expirePending(eventID) })
		return
	}
	if isSendKind(pending.kind) {
		out := &store.Outgoing{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, ClientMessageID: pending.clientMessageID,
			Status: protocol.StatusUnknown, Error: protocol.ErrTimeout,
		}
		if err := c.recordUntilCommitted(func(ctx context.Context) error { return c.recordSend(ctx, pending.owner, out, false) }); isPermanent(err) {
			c.Log.Error().Str("code", "invalid_event").Stringer("event_id", eventID).Msg("A send can't be marked unknown; carrying on as if it were")
		} else if err != nil {
			c.Log.Err(err).Msg("Failed to mark send unknown")
			return
		}
	}
	pending.timedOut = true
	if pending.returned {
		c.releaseForRetention(eventID, pending)
		return
	}
	// Its handler is still running in bridgev2: the person is told a send may not have gone
	// out, and the chat stays held until bridgev2 reports the outcome, or holdLimit passes.
	pending.timer = time.AfterFunc(holdLimit*c.SendTimeout, func() { c.releaseHeld(eventID, pending) })
}

// releaseHeld ends the hold of a command that is still inside bridgev2 long after it was due:
// bridgev2 hasn't reported its outcome, and may never.
func (c *Connector) releaseHeld(eventID id.EventID, pending *pendingCommand) {
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.settled || pending.released {
		return
	}
	c.Log.Warn().Stringer("event_id", eventID).
		Msg("A command is still inside the network connector long after it was due; releasing its chat")
	c.releaseForRetention(eventID, pending)
}

// releaseDeletedChat ends the hold on a chat whose portal bridgev2 has deleted. bridgev2
// reports no outcome for an event in a deleted portal, so a send still out is marked
// unknown (it may have reached the network) and the chat's later commands can run. Nothing
// is sent again.
func (c *Connector) releaseDeletedChat(portalID string) {
	raw, ok := c.busy.Load(portalID)
	if !ok {
		return
	}
	eventID := raw.(id.EventID)
	p, ok := c.pending.Load(eventID)
	if !ok {
		c.busy.CompareAndDelete(portalID, eventID)
		c.wakeWorker()
		return
	}
	pending := p.(*pendingCommand)
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.settled {
		return
	}
	if pending.timer != nil {
		pending.timer.Stop()
	}
	if isSendKind(pending.kind) && !pending.timedOut {
		out := &store.Outgoing{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, ClientMessageID: pending.clientMessageID,
			Status: protocol.StatusUnknown, Error: protocol.ErrInternal,
		}
		if err := c.recordUntilCommitted(func(ctx context.Context) error { return c.recordSend(ctx, pending.owner, out, false) }); err != nil {
			c.Log.Error().Str("error_type", errorType(err)).Stringer("event_id", eventID).Msg("Failed to mark a send in a deleted chat unknown")
		}
	}
	c.Log.Debug().Stringer("event_id", eventID).Msg("Chat deleted while a command was out; releasing it")
	pending.settled = true
	c.pending.CompareAndDelete(eventID, pending)
	c.release(eventID, pending)
}

func (c *Connector) emitSendStatus(ctx context.Context, o *owner, clientMessageID, status, eventID, errMsg string) error {
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventSendStatus, UserID: o.userID, LoginID: o.loginID,
		ClientMessageID: clientMessageID, Status: status, EventID: eventID, Error: errMsg,
	})
}

// SendMessageStatus is bridgev2 reporting the outcome of a Matrix-side event.
// The command stays pending (its timer stopped, the chat held) until its outcome is
// committed: a database that is briefly unavailable doesn't lose a send the network confirmed.
func (c *Connector) SendMessageStatus(ctx context.Context, ms *bridgev2.MessageStatus, info *bridgev2.MessageStatusEventInfo) {
	raw, ok := c.pending.Load(info.SourceEventID)
	if !ok {
		return
	}
	pending := raw.(*pendingCommand)
	pending.lock.Lock()
	defer pending.lock.Unlock()
	if pending.settled {
		return
	}
	if pending.timer != nil {
		pending.timer.Stop()
	}
	err := c.recordUntilCommitted(func(ctx context.Context) error { return c.handleOutcome(ctx, pending, ms, info) })
	if isPermanent(err) {
		// The outcome's events can never be journaled (the backend would refuse them), so
		// retrying is pointless and would hold the chat for good. A send is recorded as what
		// can still be said about it, `unknown`, and the chat goes on. Only a code is logged:
		// the error describes the event.
		c.Log.Error().Str("code", "invalid_event").Stringer("event_id", info.SourceEventID).
			Msg("A command's outcome can't be recorded as reported; recording it as unknown")
		err = nil
		if isSendKind(pending.kind) {
			out := &store.Outgoing{
				UserID: pending.owner.userID, LoginID: pending.owner.loginID, ClientMessageID: pending.clientMessageID,
				Status: protocol.StatusUnknown, Error: protocol.ErrInternal,
			}
			if err = c.recordUntilCommitted(func(ctx context.Context) error { return c.recordSend(ctx, pending.owner, out, false) }); isPermanent(err) {
				err = nil
			}
		}
	}
	if err != nil {
		c.Log.Err(err).Stringer("event_id", info.SourceEventID).Msg("Failed to record command outcome; it is settled at the next start")
		return
	}
	// bridgev2 reports an outcome once the handler has finished, so the chat can go on now,
	// even if this send was marked unknown while it was still running.
	pending.returned = true
	pending.settled = true
	c.pending.CompareAndDelete(info.SourceEventID, pending)
	c.release(info.SourceEventID, pending)
}

// outcomeAttemptTimeout bounds one attempt at writing an outcome.
const outcomeAttemptTimeout = 30 * time.Second

// isPermanent is a failure to write an outcome that writing again can't fix: an event the
// backend would refuse, which the journal won't take.
func isPermanent(err error) bool { return errors.Is(err, protocol.ErrInvalidEvent) }

// recordUntilCommitted retries writing an outcome until it commits or the bridge stops. A
// permanent failure (isPermanent) is returned at once, for the caller to record what it can.
// Every attempt gets a fresh context from the bridge's lifetime, never the caller's: bridgev2
// reports an outcome with the chat's context, which is cancelled if the chat is deleted, and
// an outcome the network confirmed must still be recorded then. A send left unrecorded when
// the bridge stops is still `submitted` in the store, and the next start marks it unknown
// (MarkInFlightUnknown): never sent again, and the person decides.
func (c *Connector) recordUntilCommitted(write func(ctx context.Context) error) error {
	delay := 200 * time.Millisecond
	for {
		attempt, cancel := context.WithTimeout(c.Bridge.BackgroundCtx, outcomeAttemptTimeout)
		err := write(attempt)
		cancel()
		if err == nil || errors.Is(err, errAlreadyRecorded) {
			return nil
		} else if isPermanent(err) {
			return err
		}
		c.Log.Warn().Str("error_type", errorType(err)).Dur("retry_in", delay).Msg("Recording an outcome failed; retrying")
		select {
		case <-c.Bridge.BackgroundCtx.Done():
			return err
		case <-time.After(delay):
		}
		delay = min(delay*2, 30*time.Second)
	}
}

func (c *Connector) handleOutcome(ctx context.Context, pending *pendingCommand, ms *bridgev2.MessageStatus, info *bridgev2.MessageStatusEventInfo) error {
	success := ms.Status == event.MessageStatusSuccess
	eventID := string(info.SourceEventID)
	switch pending.kind {
	case pendingSend, pendingEdit:
		out := &store.Outgoing{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, ClientMessageID: pending.clientMessageID, EventID: eventID,
		}
		if !success {
			// Only a refusal bridgev2 is sure of is a failure; anything else may have reached
			// the network, so it is unknown and never retried here. A send whose attachment
			// was refused to the connector for its deadline never had its media to send.
			out.Status = protocol.StatusUnknown
			if ms.IsCertain || pending.refusedLate {
				out.Status = protocol.StatusFailed
			}
			out.Error = sendErrorCode(ms)
			if pending.refusedLate {
				out.Error = protocol.ErrExpired
			}
			// Only the error's type is logged: a connector's error text can quote content.
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", ms.InternalError)).Str("code", out.Error).
				Stringer("event_id", info.SourceEventID).Str("status", out.Status).Msg("Send didn't go through")
			return c.recordSend(ctx, pending.owner, out, false)
		}
		out.Status = protocol.StatusSent
		echo := &protocol.Event{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, PortalID: pending.owner.portalID,
			EventID: eventID, Sender: &protocol.SelfSender, Sealed: pending.echo, NetworkTS: time.Now().UnixMilli(),
			ClientMessageID: pending.clientMessageID,
		}
		if pending.kind == pendingEdit {
			echo.Type, echo.TargetEventID = protocol.EventEdit, pending.targetEventID
		} else {
			historical := false
			echo.Type, echo.Historical, echo.ReplyTo = protocol.EventMessage, &historical, pending.replyTo
		}
		return c.recordSend(ctx, pending.owner, out, false, echo)
	case pendingReact:
		if !success {
			return nil
		}
		if err := c.Store.PutReaction(ctx, eventID, pending.targetEventID, pending.key, sender{self: true}.indexKey()); err != nil {
			return err
		}
		return c.emit(ctx, &protocol.Event{
			Type: protocol.EventReaction, UserID: pending.owner.userID, LoginID: pending.owner.loginID, PortalID: pending.owner.portalID,
			EventID: eventID, TargetEventID: pending.targetEventID, Key: pending.key, Sender: &protocol.SelfSender,
			NetworkTS: time.Now().UnixMilli(),
		})
	case pendingRedact:
		if !success {
			return nil
		}
		evt := &protocol.Event{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, PortalID: pending.owner.portalID,
			TargetEventID: pending.targetEventID, Sender: &protocol.SelfSender,
		}
		if pending.key != "" {
			evt.Type, evt.Key = protocol.EventReactionRemove, pending.key
			if err := c.Store.DeleteReaction(ctx, pending.targetEventID); err != nil {
				return err
			}
		} else {
			evt.Type, evt.NetworkTS = protocol.EventRedaction, time.Now().UnixMilli()
		}
		return c.emit(ctx, evt)
	}
	return nil
}

// MarkInFlightUnknown runs at startup: a send that was in flight when the process stopped
// may or may not have reached the network, so it becomes unknown rather than being retried.
func (c *Connector) MarkInFlightUnknown(ctx context.Context) error {
	inFlight, err := c.Store.OutgoingInFlight(ctx)
	if err != nil {
		return err
	}
	for _, out := range inFlight {
		o := &owner{userID: out.UserID, loginID: out.LoginID}
		out.Status, out.Error = protocol.StatusUnknown, protocol.ErrInternal
		if err = c.recordSend(ctx, o, out, false); err != nil {
			return err
		}
	}
	return nil
}

// sendErrorCode turns bridgev2's message status into a protocol error code.
func sendErrorCode(ms *bridgev2.MessageStatus) string {
	switch {
	case errors.Is(ms.InternalError, bridgev2.ErrNotLoggedIn):
		return protocol.ErrNotConnected
	case ms.ErrorReason == event.MessageStatusUnsupported:
		return protocol.ErrUnsupported
	case ms.ErrorReason == event.MessageStatusTooOld:
		return protocol.ErrExpired
	case ms.ErrorReason == event.MessageStatusNetworkError, ms.ErrorReason == event.MessageStatusBridgeUnavailable:
		return protocol.ErrNotConnected
	case ms.IsCertain:
		return protocol.ErrNetworkRejected
	default:
		return protocol.ErrInternal
	}
}

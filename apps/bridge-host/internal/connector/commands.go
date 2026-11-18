package connector

import (
	"context"
	"errors"
	"fmt"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// CommandError is a command refused before it ran. The server turns it into a 4xx.
type CommandError struct {
	Status  int
	Message string
}

func (e *CommandError) Error() string { return e.Message }

func badRequest(format string, args ...any) error {
	return &CommandError{Status: 400, Message: fmt.Sprintf(format, args...)}
}

func conflict(format string, args ...any) error {
	return &CommandError{Status: 409, Message: fmt.Sprintf(format, args...)}
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
// SendMessageStatus. It holds the plaintext of a send in memory only, to seal the person's
// copy once the network accepts it. If the process stops first, the send becomes unknown.
type pendingCommand struct {
	kind            pendingKind
	owner           *owner
	clientMessageID string
	targetEventID   string
	key             string
	plaintext       *protocol.MessagePlaintext
	replyTo         string
	timer           *time.Timer
}

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
		return nil, conflict("user %s has no logins on this bridge host", cmd.UserID)
	}
	if cmd.LoginID == "" {
		return nil, badRequest("loginId is required")
	}
	rawLogin, err := c.Store.LookupID(ctx, cmd.LoginID, ids.KindLogin)
	if errors.Is(err, store.ErrNotFound) {
		return nil, conflict("unknown login")
	} else if err != nil {
		return nil, err
	}
	t.login = c.Bridge.GetCachedUserLoginByID(networkid.UserLoginID(rawLogin))
	// A person can only act through their own logins.
	if t.login == nil || t.login.UserMXID != t.userMXID {
		return nil, conflict("login isn't connected for this user")
	}
	if !needPortal {
		return t, nil
	}
	rawPortal, err := c.Store.LookupID(ctx, cmd.PortalID, ids.KindPortal)
	if errors.Is(err, store.ErrNotFound) {
		return nil, conflict("unknown portal")
	} else if err != nil {
		return nil, err
	}
	key := ids.ParsePortalValue(rawPortal)
	if key.Receiver != t.login.ID {
		return nil, conflict("portal doesn't belong to this login")
	}
	if t.portal, err = c.Bridge.GetExistingPortalByKey(ctx, key); err != nil {
		return nil, err
	} else if t.portal == nil || t.portal.MXID == "" {
		return nil, conflict("portal doesn't exist")
	}
	if t.owner, err = c.owner(ctx, t.portal.MXID); err != nil {
		return nil, err
	}
	return t, nil
}

// HandleCommand runs a gateway command. It returns once the command is queued; outcomes
// arrive as events.
func (c *Connector) HandleCommand(ctx context.Context, cmd *protocol.Command) error {
	switch cmd.Type {
	case protocol.CommandSend, protocol.CommandEdit:
		return c.handleSend(ctx, cmd)
	case protocol.CommandReact:
		return c.handleReact(ctx, cmd)
	case protocol.CommandUnreact, protocol.CommandRedact:
		return c.handleRedact(ctx, cmd)
	case protocol.CommandMarkRead:
		return c.handleMarkRead(ctx, cmd)
	case protocol.CommandTyping:
		return c.handleTyping(ctx, cmd)
	case protocol.CommandLoginStart:
		return c.handleLoginStart(ctx, cmd)
	case protocol.CommandLoginSubmit:
		return c.handleLoginSubmit(ctx, cmd)
	case protocol.CommandLoginCancel:
		return c.handleLoginCancel(ctx, cmd)
	case protocol.CommandLogout:
		return c.handleLogout(ctx, cmd)
	case protocol.CommandBackfill:
		return c.handleBackfill(ctx, cmd)
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
func (c *Connector) matrixContent(t *target, plain *protocol.MessagePlaintext, timeout time.Duration) (*event.MessageEventContent, event.Type, error) {
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
		uri, err := c.Media.Register(att, t.owner.userID, timeout)
		if err != nil {
			return nil, evtType, badRequest("invalid attachment: %v", err)
		}
		content.URL = uri
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
		return badRequest("sealed content can't be opened by the bridge key: %v", err)
	}
	return nil
}

func (c *Connector) handleSend(ctx context.Context, cmd *protocol.Command) error {
	if cmd.ClientMessageID == "" {
		return badRequest("clientMessageId is required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	// A repeated send is never sent again: the last known status is repeated instead.
	if existing, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); err == nil {
		return c.emitSendStatus(ctx, t.owner, existing.ClientMessageID, existing.Status, existing.EventID, existing.Error)
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	var plain protocol.MessagePlaintext
	if err = c.openOutbound(cmd, cmd.UserID, cmd.ClientMessageID, &plain); err != nil {
		return err
	}
	content, evtType, err := c.matrixContent(t, &plain, c.SendTimeout)
	if err != nil {
		return err
	}
	eventID := ids.OutgoingEventID(cmd.UserID, cmd.ClientMessageID)
	pending := &pendingCommand{kind: pendingSend, owner: t.owner, clientMessageID: cmd.ClientMessageID, plaintext: &plain}
	if cmd.Type == protocol.CommandEdit {
		if cmd.TargetEventID == "" {
			return badRequest("targetEventId is required")
		}
		pending.kind, pending.targetEventID = pendingEdit, cmd.TargetEventID
		edit := *content
		content = &event.MessageEventContent{MsgType: edit.MsgType, Body: "* " + edit.Body, NewContent: &edit}
		content.SetEdit(id.EventID(cmd.TargetEventID))
	} else if cmd.ReplyTo != "" {
		pending.replyTo = cmd.ReplyTo
		content.RelatesTo = (&event.RelatesTo{}).SetReplyTo(id.EventID(cmd.ReplyTo))
	}
	inserted, err := c.Store.InsertOutgoing(ctx, &store.Outgoing{
		UserID: cmd.UserID, LoginID: t.owner.loginID, ClientMessageID: cmd.ClientMessageID, EventID: string(eventID),
		Status: protocol.StatusSubmitted,
	})
	if err != nil {
		return err
	} else if !inserted {
		// Raced with the same send: the other request owns it.
		return nil
	}
	c.trackPending(eventID, pending)
	if err = c.emitSendStatus(ctx, t.owner, cmd.ClientMessageID, protocol.StatusSubmitted, "", ""); err != nil {
		return err
	}
	c.queue(ctx, t, &event.Event{Type: evtType, ID: eventID, Content: event.Content{Parsed: content}})
	return nil
}

func (c *Connector) handleReact(ctx context.Context, cmd *protocol.Command) error {
	if cmd.TargetEventID == "" || cmd.Key == "" {
		return badRequest("targetEventId and key are required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	eventID := ids.CommandEventID(cmd.UserID, cmd.CommandID)
	c.trackPending(eventID, &pendingCommand{kind: pendingReact, owner: t.owner, targetEventID: cmd.TargetEventID, key: reactionKey(cmd.Key)})
	c.queue(ctx, t, &event.Event{
		Type: event.EventReaction, ID: eventID,
		Content: event.Content{Parsed: &event.ReactionEventContent{RelatesTo: event.RelatesTo{
			Type: event.RelAnnotation, EventID: id.EventID(cmd.TargetEventID), Key: cmd.Key,
		}}},
	})
	return nil
}

func (c *Connector) handleRedact(ctx context.Context, cmd *protocol.Command) error {
	if cmd.TargetEventID == "" {
		return badRequest("targetEventId is required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
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
	eventID := ids.CommandEventID(cmd.UserID, cmd.CommandID)
	c.trackPending(eventID, pending)
	c.queue(ctx, t, &event.Event{
		Type: event.EventRedaction, ID: eventID, Redacts: redacts,
		Content: event.Content{Parsed: &event.RedactionEventContent{Redacts: redacts}},
	})
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
		return "", conflict("unknown target message")
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
	return "", conflict("no reaction with that key from this user")
}

func (c *Connector) handleMarkRead(ctx context.Context, cmd *protocol.Command) error {
	if cmd.UpToEventID == "" {
		return badRequest("upToEventId is required")
	}
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
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

func (c *Connector) handleTyping(ctx context.Context, cmd *protocol.Command) error {
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
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

func (c *Connector) handleLogout(ctx context.Context, cmd *protocol.Command) error {
	t, err := c.resolve(ctx, cmd, false)
	if err != nil {
		return err
	}
	go t.login.Logout(c.Bridge.BackgroundCtx)
	return nil
}

func (c *Connector) handleBackfill(ctx context.Context, cmd *protocol.Command) error {
	t, err := c.resolve(ctx, cmd, true)
	if err != nil {
		return err
	}
	o := t.owner
	c.Bridge.WakeupBackfillQueue(&bridgev2.ManualBackfill{
		Source: t.login,
		Portal: t.portal,
		DoneCallback: func(err error) {
			more := err == nil
			if emitErr := c.emit(c.Bridge.BackgroundCtx, &protocol.Event{
				Type: protocol.EventBackfillDone, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID,
				Direction: "backward", More: &more,
			}); emitErr != nil {
				c.Log.Err(emitErr).Msg("Failed to record backfill completion")
			}
		},
	})
	return nil
}

// queue hands a Matrix-side event to bridgev2 as if a homeserver had delivered it.
func (c *Connector) queue(ctx context.Context, t *target, evt *event.Event) {
	evt.Sender = t.userMXID
	evt.RoomID = t.portal.MXID
	evt.Timestamp = time.Now().UnixMilli()
	evt.Mautrix.EventSource = event.SourceTimeline
	res := c.Bridge.QueueMatrixEvent(c.Bridge.BackgroundCtx, evt)
	if !res.Success && !res.Queued {
		c.Log.Warn().Err(res.Error).Stringer("event_id", evt.ID).Msg("bridgev2 refused a command's event")
	}
}

func (c *Connector) trackPending(eventID id.EventID, pending *pendingCommand) {
	pending.timer = time.AfterFunc(c.SendTimeout, func() { c.expirePending(eventID) })
	c.pending.Store(eventID, pending)
}

// expirePending marks a send unknown when bridgev2 never reported its outcome.
func (c *Connector) expirePending(eventID id.EventID) {
	raw, ok := c.pending.LoadAndDelete(eventID)
	if !ok {
		return
	}
	pending := raw.(*pendingCommand)
	if pending.kind != pendingSend && pending.kind != pendingEdit {
		return
	}
	ctx := c.Bridge.BackgroundCtx
	if err := c.setSendStatus(ctx, pending, protocol.StatusUnknown, "", "no outcome was reported in time"); err != nil {
		c.Log.Err(err).Msg("Failed to mark send unknown")
	}
}

func (c *Connector) emitSendStatus(ctx context.Context, o *owner, clientMessageID, status, eventID, errMsg string) error {
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventSendStatus, UserID: o.userID, LoginID: o.loginID,
		ClientMessageID: clientMessageID, Status: status, EventID: eventID, Error: errMsg,
	})
}

func (c *Connector) setSendStatus(ctx context.Context, pending *pendingCommand, status, eventID, errMsg string) error {
	if err := c.Store.SetOutgoingStatus(ctx, pending.owner.userID, pending.clientMessageID, status, errMsg); err != nil {
		return err
	}
	return c.emitSendStatus(ctx, pending.owner, pending.clientMessageID, status, eventID, errMsg)
}

// SendMessageStatus is bridgev2 reporting the outcome of a Matrix-side event.
func (c *Connector) SendMessageStatus(ctx context.Context, ms *bridgev2.MessageStatus, info *bridgev2.MessageStatusEventInfo) {
	raw, ok := c.pending.LoadAndDelete(info.SourceEventID)
	if !ok {
		return
	}
	pending := raw.(*pendingCommand)
	pending.timer.Stop()
	if err := c.handleOutcome(ctx, pending, ms, info); err != nil {
		c.Log.Err(err).Stringer("event_id", info.SourceEventID).Msg("Failed to record command outcome")
	}
}

func (c *Connector) handleOutcome(ctx context.Context, pending *pendingCommand, ms *bridgev2.MessageStatus, info *bridgev2.MessageStatusEventInfo) error {
	success := ms.Status == event.MessageStatusSuccess
	eventID := string(info.SourceEventID)
	switch pending.kind {
	case pendingSend, pendingEdit:
		if !success {
			status := protocol.StatusUnknown
			// Only a refusal bridgev2 is sure of is a failure; anything else may have reached
			// the network, so it is unknown and never retried here.
			if ms.IsCertain {
				status = protocol.StatusFailed
			}
			errMsg := ms.Message
			if errMsg == "" && ms.InternalError != nil {
				errMsg = ms.InternalError.Error()
			}
			return c.setSendStatus(ctx, pending, status, "", errMsg)
		}
		if err := c.setSendStatus(ctx, pending, protocol.StatusSent, eventID, ""); err != nil {
			return err
		}
		// The person's own copy, sealed now that the network accepted it.
		sealed, err := c.seal(ctx, pending.owner, seal.KindMessage, eventID, pending.plaintext)
		if err != nil {
			return err
		}
		pending.plaintext = nil
		evt := &protocol.Event{
			UserID: pending.owner.userID, LoginID: pending.owner.loginID, PortalID: pending.owner.portalID,
			EventID: eventID, Sender: &protocol.SelfSender, Sealed: sealed, NetworkTS: time.Now().UnixMilli(),
			ClientMessageID: pending.clientMessageID,
		}
		if pending.kind == pendingEdit {
			evt.Type, evt.TargetEventID = protocol.EventEdit, pending.targetEventID
		} else {
			historical := false
			evt.Type, evt.Historical, evt.ReplyTo = protocol.EventMessage, &historical, pending.replyTo
		}
		return c.emit(ctx, evt)
	case pendingReact:
		if !success {
			return nil
		}
		if err := c.Store.PutReaction(ctx, eventID, pending.targetEventID, pending.key); err != nil {
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
		if err = c.Store.SetOutgoingStatus(ctx, out.UserID, out.ClientMessageID, protocol.StatusUnknown, "interrupted by a restart"); err != nil {
			return err
		}
		if err = c.emitSendStatus(ctx, o, out.ClientMessageID, protocol.StatusUnknown, "", "interrupted by a restart"); err != nil {
			return err
		}
	}
	return nil
}

package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"go.mau.fi/util/variationselector"
	"golang.org/x/crypto/chacha20poly1305"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

type intentKind int

const (
	intentBot intentKind = iota
	intentGhost
	intentUser
)

// Intent is a bridgev2.MatrixAPI for the bridge bot, a ghost (a remote user) or a person's
// double puppet. What each "sends to Matrix" becomes protocol events.
type Intent struct {
	c       *Connector
	mxid    id.UserID
	kind    intentKind
	ghostID networkid.UserID
	userID  string
}

var _ bridgev2.MatrixAPI = (*Intent)(nil)

func (in *Intent) GetMXID() id.UserID   { return in.mxid }
func (in *Intent) IsDoublePuppet() bool { return in.kind == intentUser }

// sender is how this intent appears in protocol events. The bot has no protocol identity:
// what it sends (notices, bridge info) isn't part of any conversation.
type sender struct {
	self    bool
	ghostID networkid.UserID
}

func (in *Intent) sender() (sender, bool) {
	switch in.kind {
	case intentUser:
		return sender{self: true}, true
	case intentGhost:
		return sender{ghostID: in.ghostID}, true
	default:
		return sender{}, false
	}
}

// indexKey is how the reaction index keeps a sender: `self`, or `ghost:` and the network ID.
func (s sender) indexKey() string {
	if s.self {
		return "self"
	}
	return "ghost:" + string(s.ghostID)
}

func senderFromIndex(key string) (sender, bool) {
	if key == "self" {
		return sender{self: true}, true
	} else if ghost, ok := strings.CutPrefix(key, "ghost:"); ok && ghost != "" {
		return sender{ghostID: networkid.UserID(ghost)}, true
	}
	return sender{}, false
}

func (c *Connector) senderForMXID(mxid id.UserID) (sender, bool) {
	if ghost, ok := ids.ParseGhostMXID(mxid); ok {
		return sender{ghostID: ghost}, true
	} else if _, ok = ids.ParseUserMXID(mxid); ok {
		return sender{self: true}, true
	}
	return sender{}, false
}

// protocolSender converts a sender, making sure the owner has the ghost's profile.
func (c *Connector) protocolSender(ctx context.Context, o *owner, s sender) (*protocol.Sender, error) {
	if s.self {
		return &protocol.SelfSender, nil
	}
	ghostID, err := c.ghostOpaque(ctx, s.ghostID)
	if err != nil {
		return nil, err
	}
	if err = c.ensureContact(ctx, o, s.ghostID); err != nil {
		return nil, err
	}
	return &protocol.Sender{GhostID: ghostID}, nil
}

// SendMessage turns a message, edit, reaction or redaction into its protocol event. A part of
// a message whose network will send it again if it isn't acknowledged (package handled) is
// recorded as in flight first, until bridgev2 says how handling it ended (remoteEventDone):
// bridgev2 saves each part as it goes, and a part left saved by a handling that failed, or
// that a stop cut off, would make it drop the redelivery as a duplicate.
func (in *Intent) SendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	remote := bridgev2.GetRemoteEventFromContext(ctx)
	if messagePart(remote, eventType, content, extra) {
		m := handled.Message{Receiver: string(extra.MessageMeta.Room.Receiver), ID: string(extra.MessageMeta.ID)}
		if handled.NoteMessage(remote, m) {
			if err := in.c.Store.PutInflight(ctx, store.InflightMessage{Receiver: m.Receiver, MessageID: m.ID}); err != nil {
				return nil, err
			}
		}
	}
	return in.sendMessage(ctx, roomID, eventType, content, extra)
}

// messagePart says whether a write is a part of the message a remote event brings, as against
// an edit, a reaction, or something bridgev2 writes on the side (an error notice when the
// message couldn't be converted).
func messagePart(remote bridgev2.RemoteEvent, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) bool {
	if remote == nil || extra == nil || extra.MessageMeta == nil || isEdit(content) {
		return false
	}
	if eventType != event.EventMessage && eventType != event.EventSticker {
		return false
	}
	switch remote.GetType() {
	case bridgev2.RemoteEventMessage, bridgev2.RemoteEventMessageUpsert:
		msg, ok := remote.(bridgev2.RemoteMessage)
		return ok && extra.MessageMeta.ID == msg.GetID()
	}
	return false
}

// remoteSourceID is the network's own ID for the remote event being handled, where its
// connector gives one (a WhatsApp reaction is a message with its own ID; Signal's is its
// sender and millisecond timestamp), or "".
func remoteSourceID(ctx context.Context) string {
	if remote, ok := bridgev2.GetRemoteEventFromContext(ctx).(interface{ GetID() networkid.MessageID }); ok {
		return string(remote.GetID())
	}
	return ""
}

func (in *Intent) sendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	if extra == nil {
		extra = &bridgev2.MatrixSendExtra{}
	}
	ts := extra.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}
	var eventID id.EventID
	switch {
	case extra.MessageMeta != nil && !isEdit(content):
		eventID = ids.MessageEventID(extra.MessageMeta.Room, extra.MessageMeta.ID, extra.MessageMeta.PartID)
	case extra.ReactionMeta != nil:
		r := extra.ReactionMeta
		eventID = ids.RemoteReactionEventID(r.Room, r.MessageID, r.MessagePartID, r.SenderID, r.EmojiID, r.Emoji, remoteSourceID(ctx), r.Timestamp)
	default:
		eventID = ids.LocalEventID(string(roomID), string(in.mxid), eventType.Type, strconv.FormatInt(ts.UnixNano(), 10), digest(content))
	}
	s, ok := in.sender()
	if !ok && eventType == event.EventRedaction {
		// bridgev2's bot takes away a person's older reaction when the network allows only
		// one (WhatsApp, Signal): that removal is the person's, so it is said as theirs.
		s, ok, err := in.c.reactionSender(ctx, content)
		if err != nil {
			return nil, err
		} else if ok {
			return in.c.botRedaction(ctx, roomID, s, eventType, content, eventID, ts)
		}
	}
	if !ok {
		return &mautrix.RespSendEvent{EventID: eventID}, nil
	}
	o, err := in.c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return &mautrix.RespSendEvent{EventID: eventID}, nil
	} else if err != nil {
		return nil, err
	}
	if err = in.c.emitContent(ctx, o, s, eventType, content, eventID, ts, false); err != nil {
		return nil, err
	}
	return &mautrix.RespSendEvent{EventID: eventID}, nil
}

// reactionSender is who gave the reaction a redaction takes away, if it takes away one the
// bridge host has indexed.
func (c *Connector) reactionSender(ctx context.Context, content *event.Content) (sender, bool, error) {
	redaction, ok := content.Parsed.(*event.RedactionEventContent)
	if !ok {
		return sender{}, false, nil
	}
	indexed, err := c.Store.ReactionSender(ctx, string(redaction.Redacts))
	if errors.Is(err, store.ErrNotFound) {
		return sender{}, false, nil
	} else if err != nil {
		return sender{}, false, err
	}
	// The index says who, since bridgev2 may already have given the person's one reaction
	// slot to the new reaction. The upgrade that added senders filled them in from bridgev2;
	// one it couldn't is looked up there now, in case bridgev2 still has it.
	if s, ok := senderFromIndex(indexed); ok {
		return s, true, nil
	}
	reaction, err := c.Bridge.DB.Reaction.GetByMXID(ctx, redaction.Redacts)
	if err != nil || reaction == nil {
		return sender{}, false, err
	}
	s, ok := senderFromIndex(store.ReactorKey(string(reaction.SenderMXID), string(reaction.SenderID)))
	return s, ok, nil
}

// botRedaction emits a redaction the bot sent on someone's behalf (reactionSender).
func (c *Connector) botRedaction(ctx context.Context, roomID id.RoomID, s sender, eventType event.Type, content *event.Content, eventID id.EventID, ts time.Time) (*mautrix.RespSendEvent, error) {
	o, err := c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return &mautrix.RespSendEvent{EventID: eventID}, nil
	} else if err != nil {
		return nil, err
	}
	if err = c.emitContent(ctx, o, s, eventType, content, eventID, ts, false); err != nil {
		return nil, err
	}
	return &mautrix.RespSendEvent{EventID: eventID}, nil
}

// reactionKey normalizes an emoji. bridgev2 adds variation selectors on the way "to
// Matrix" and networks may or may not, so keys are compared without them.
func reactionKey(key string) string {
	return variationselector.Remove(key)
}

func isEdit(content *event.Content) bool {
	msg, ok := content.Parsed.(*event.MessageEventContent)
	return ok && msg.RelatesTo.GetReplaceID() != ""
}

// digest makes event IDs for edits and other events without a stable network ID unique
// without putting content into them.
func digest(content *event.Content) string {
	if content == nil {
		return ""
	}
	data, _ := content.MarshalJSON()
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

// emitContent turns one Matrix event into a protocol event for its owner.
func (c *Connector) emitContent(ctx context.Context, o *owner, s sender, eventType event.Type, content *event.Content, eventID id.EventID, ts time.Time, historical bool) error {
	if content.Parsed == nil && content.VeryRaw != nil {
		if err := content.ParseRaw(eventType); err != nil {
			return fmt.Errorf("failed to parse %s content: %w", eventType.Type, err)
		}
	}
	protoSender, err := c.protocolSender(ctx, o, s)
	if err != nil {
		return err
	}
	base := protocol.Event{UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID, Sender: protoSender, NetworkTS: ts.UnixMilli()}
	switch eventType {
	case event.EventMessage, event.EventSticker:
		msg, ok := content.Parsed.(*event.MessageEventContent)
		if !ok {
			return fmt.Errorf("unexpected %T for %s", content.Parsed, eventType.Type)
		}
		if target := msg.RelatesTo.GetReplaceID(); target != "" {
			newContent := msg.NewContent
			if newContent == nil {
				newContent = msg
			}
			sealed, err := c.seal(ctx, o, seal.KindMessage, string(eventID), fitMessage(c.messagePlaintext(ctx, o, eventType, newContent)))
			if err != nil {
				return err
			}
			base.Type, base.EventID, base.TargetEventID, base.Sealed = protocol.EventEdit, string(eventID), string(target), sealed
			return c.emit(ctx, &base)
		}
		sealed, err := c.seal(ctx, o, seal.KindMessage, string(eventID), fitMessage(c.messagePlaintext(ctx, o, eventType, msg)))
		if err != nil {
			return err
		}
		base.Type, base.EventID, base.Sealed, base.Historical = protocol.EventMessage, string(eventID), sealed, &historical
		if replyTo := msg.RelatesTo.GetNonFallbackReplyTo(); replyTo != "" {
			base.ReplyTo = string(replyTo)
		}
		if threadRoot := msg.RelatesTo.GetThreadParent(); threadRoot != "" {
			base.ThreadRoot = string(threadRoot)
		}
		base.MentionsMe = !s.self && mentions(msg.Mentions, o.userID)
		return c.emit(ctx, &base)
	case event.EventReaction:
		reaction, ok := content.Parsed.(*event.ReactionEventContent)
		if !ok {
			return fmt.Errorf("unexpected %T for reaction", content.Parsed)
		}
		base.Type, base.EventID, base.TargetEventID, base.Key = protocol.EventReaction, string(eventID), string(reaction.RelatesTo.EventID), reactionKey(reaction.RelatesTo.Key)
		if err = c.Store.PutReaction(ctx, base.EventID, base.TargetEventID, base.Key, s.indexKey()); err != nil {
			return err
		}
		return c.emit(ctx, &base)
	case event.EventRedaction:
		redaction, ok := content.Parsed.(*event.RedactionEventContent)
		if !ok {
			return fmt.Errorf("unexpected %T for redaction", content.Parsed)
		}
		// A redaction of a reaction removes the reaction; anything else deletes a message.
		target, key, err := c.Store.GetReaction(ctx, string(redaction.Redacts))
		if err == nil {
			base.Type, base.TargetEventID, base.Key, base.NetworkTS = protocol.EventReactionRemove, target, key, 0
			if err = c.emit(ctx, &base); err != nil {
				return err
			}
			return c.Store.DeleteReaction(ctx, string(redaction.Redacts))
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		base.Type, base.TargetEventID = protocol.EventRedaction, string(redaction.Redacts)
		return c.emit(ctx, &base)
	default:
		// Polls, call notices and other types aren't part of Phase 0.
		c.Log.Debug().Str("event_type", eventType.Type).Msg("Dropping unsupported event type")
		return nil
	}
}

var msgTypes = map[event.MessageType]string{
	event.MsgText:     "text",
	event.MsgNotice:   "notice",
	event.MsgEmote:    "emote",
	event.MsgImage:    "image",
	event.MsgVideo:    "video",
	event.MsgAudio:    "audio",
	event.MsgFile:     "file",
	event.MsgLocation: "location",
}

func (c *Connector) messagePlaintext(ctx context.Context, o *owner, eventType event.Type, msg *event.MessageEventContent) *protocol.MessagePlaintext {
	plain := &protocol.MessagePlaintext{Type: msgTypes[msg.MsgType], Body: msg.Body}
	if eventType == event.EventSticker {
		plain.Type = "sticker"
	} else if plain.Type == "" {
		plain.Type = "text"
	}
	if msg.Format == event.FormatHTML {
		plain.HTML = msg.FormattedBody
	}
	if msg.URL != "" {
		att, err := c.attachmentFor(ctx, msg.URL, o.userID)
		if err != nil {
			// The message still goes, with a record of the file that couldn't be kept (no key
			// or ID, so nothing to fetch): the person sees a file was sent rather than nothing.
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Bool("expired", errors.Is(err, media.ErrUnavailable)).
				Msg("An attachment couldn't be stored; sending the message with it marked failed")
			att = &protocol.Attachment{Failed: true}
			if info := msg.Info; info != nil {
				att.Size = info.Size
			}
		}
		if msg.FileName != "" {
			att.Name = msg.FileName
		} else if att.Name == "" {
			att.Name = msg.Body
		}
		if info := msg.Info; info != nil {
			if info.MimeType != "" {
				att.Mime = info.MimeType
			}
			att.Width, att.Height, att.DurationMS = info.Width, info.Height, info.Duration
		}
		if att.Mime == "" {
			att.Mime = "application/octet-stream"
		}
		plain.Attachments = []protocol.Attachment{*att}
	}
	if msg.Mentions != nil {
		for _, mxid := range msg.Mentions.UserIDs {
			if ghost, ok := ids.ParseGhostMXID(mxid); ok {
				if opaque, err := c.ghostOpaque(ctx, ghost); err == nil {
					plain.Mentions = append(plain.Mentions, opaque)
				}
			}
		}
	}
	plain.Previews = c.linkPreviews(ctx, o, msg.BeeperLinkPreviews)
	return plain
}

// attachmentRetries are the waits before trying again to store an attachment whose sealed
// copy couldn't be written (a full or failing disk, say). An upload that is gone (expired)
// isn't retried: nothing can bring it back.
var attachmentRetries = []time.Duration{200 * time.Millisecond, time.Second, 3 * time.Second}

// attachmentFor writes the owner's sealed copy of an upload, trying again while the write
// fails and ctx allows.
func (c *Connector) attachmentFor(ctx context.Context, uri id.ContentURIString, ownerUserID string) (*protocol.Attachment, error) {
	att, err := c.Media.AttachmentFor(uri, ownerUserID)
	for _, wait := range attachmentRetries {
		if err == nil || errors.Is(err, media.ErrUnavailable) {
			break
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(wait):
		}
		att, err = c.Media.AttachmentFor(uri, ownerUserID)
	}
	return att, err
}

// mentions reports whether a message mentions the person: by their own account (connectors
// write a mention of the login as the person's Matrix ID) or the whole chat.
func mentions(m *event.Mentions, userID string) bool {
	if m == nil {
		return false
	}
	if m.Room {
		return true
	}
	for _, mxid := range m.UserIDs {
		if mentioned, ok := ids.ParseUserMXID(mxid); ok && mentioned == userID {
			return true
		}
	}
	return false
}

func (in *Intent) SendState(ctx context.Context, roomID id.RoomID, eventType event.Type, stateKey string, content *event.Content, ts time.Time) (*mautrix.RespSendEvent, error) {
	eventID := ids.LocalEventID("state", string(roomID), eventType.Type, stateKey, strconv.FormatInt(time.Now().UnixNano(), 10))
	resp := &mautrix.RespSendEvent{EventID: eventID}
	if content.Parsed == nil && content.VeryRaw != nil {
		_ = content.ParseRaw(eventType)
	}
	switch eventType {
	case event.StateMember:
		member, ok := content.Parsed.(*event.MemberEventContent)
		if !ok {
			return resp, nil
		}
		return resp, in.c.setMembership(ctx, roomID, id.UserID(stateKey), member.Membership)
	case event.StateRoomName, event.StateTopic, event.StateRoomAvatar:
		return resp, in.c.emitChat(ctx, roomID, chatOverride{eventType: eventType, content: content})
	case event.StateBridge, event.StateHalfShotBridge:
		// bridgev2 says a chat became, or stopped being, a message request only in its bridge
		// info. Sent as often as anything about the chat changes, so only a change in the
		// request is passed on.
		info, ok := content.Parsed.(*event.BridgeEventContent)
		if !ok {
			return resp, nil
		}
		changed, err := in.c.requestChanged(ctx, roomID, info.Channel.MessageRequest)
		if err != nil || !changed {
			return resp, err
		}
		request := info.Channel.MessageRequest
		if err = in.c.emitChat(ctx, roomID, chatOverride{request: &request}); errors.Is(err, errNotPortal) {
			err = nil
		}
		return resp, err
	default:
		return resp, nil
	}
}

// requestsRoom records which of a person's chats were last sent as message requests.
func requestsRoom(userID string) string { return "requests:" + userID }

// requestChanged reports whether a chat's message request state differs from what was last
// sent for it.
func (c *Connector) requestChanged(ctx context.Context, roomID id.RoomID, request bool) (bool, error) {
	o, err := c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	sent, err := c.Store.IsMember(ctx, requestsRoom(o.userID), o.portalID)
	return err == nil && sent != request, err
}

// requestState is what a chat event says of the message request: true while it is one, false
// once, the first time after it stopped being one, and nothing otherwise, so a network
// without requests never touches the person's own choice. The marker is set before a true is
// sent (sending it again is harmless) and cleared only once a false is.
func (c *Connector) requestState(ctx context.Context, o *owner, request bool) (state *bool, sent func(), err error) {
	room := requestsRoom(o.userID)
	if request {
		if _, err = c.Store.AddMember(ctx, room, o.portalID); err != nil {
			return nil, nil, err
		}
		return &request, func() {}, nil
	}
	marked, err := c.Store.IsMember(ctx, room, o.portalID)
	if err != nil || !marked {
		return nil, func() {}, err
	}
	return &request, func() {
		if err := c.Store.RemoveMember(ctx, room, o.portalID); err != nil {
			c.Log.Err(err).Msg("Forgetting an accepted message request failed; it is sent again with the chat's next change")
		}
	}, nil
}

// setMembership records a member joining or leaving a chat after it was created, and chooses
// the chat's collage again.
func (c *Connector) setMembership(ctx context.Context, roomID id.RoomID, mxid id.UserID, membership event.Membership) error {
	changed, err := c.recordMembership(ctx, roomID, mxid, membership)
	if err != nil || !changed {
		return err
	}
	if _, isGhost := ids.ParseGhostMXID(mxid); isGhost {
		c.refreshCollageOrLog(ctx, roomID, collageChange{})
	}
	return nil
}

// recordMembership records a member joining or leaving, and says whether it changed anything.
func (c *Connector) recordMembership(ctx context.Context, roomID id.RoomID, mxid id.UserID, membership event.Membership) (bool, error) {
	switch membership {
	case event.MembershipJoin, event.MembershipInvite:
		added, err := c.Store.AddMember(ctx, string(roomID), string(mxid))
		if err != nil || !added {
			return false, err
		}
		if ghost, ok := ids.ParseGhostMXID(mxid); ok {
			o, err := c.owner(ctx, roomID)
			if errors.Is(err, errNotPortal) {
				return true, nil
			} else if err != nil {
				return true, err
			}
			return true, c.ensureContact(ctx, o, ghost)
		}
		return true, nil
	case event.MembershipLeave, event.MembershipBan:
		return true, c.Store.RemoveMember(ctx, string(roomID), string(mxid))
	default:
		return false, nil
	}
}

func (in *Intent) MarkRead(ctx context.Context, roomID id.RoomID, eventID id.EventID, ts time.Time) error {
	s, ok := in.sender()
	if !ok {
		return nil
	}
	o, err := in.c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return nil
	} else if err != nil {
		return err
	}
	protoSender, err := in.c.protocolSender(ctx, o, s)
	if err != nil {
		return err
	}
	if ts.IsZero() {
		ts = time.Now()
	}
	return in.c.emit(ctx, &protocol.Event{
		Type: protocol.EventReceipt, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID,
		Sender: protoSender, UpToEventID: string(eventID), NetworkTS: ts.UnixMilli(),
	})
}

func (in *Intent) MarkUnread(ctx context.Context, roomID id.RoomID, unread bool) error { return nil }

func (in *Intent) MarkTyping(ctx context.Context, roomID id.RoomID, typingType bridgev2.TypingType, timeout time.Duration) error {
	s, ok := in.sender()
	if !ok {
		return nil
	}
	o, err := in.c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return nil
	} else if err != nil {
		return err
	}
	protoSender, err := in.c.protocolSender(ctx, o, s)
	if err != nil {
		return err
	}
	typing := timeout > 0
	timeoutMS := timeout.Milliseconds()
	return in.c.emit(ctx, &protocol.Event{
		Type: protocol.EventTyping, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID,
		Sender: protoSender, Typing: &typing, TimeoutMS: &timeoutMS,
	})
}

func (in *Intent) DownloadMedia(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo) ([]byte, error) {
	// A connector reads a send's attachment just before uploading and transmitting it, the
	// latest point a send's deadline can be checked.
	if err := in.c.checkTransmitDeadline(ctx); err != nil {
		return nil, err
	}
	if file != nil {
		uri = file.URL
	}
	if err := in.c.reserveMedia(ctx, uri); err != nil {
		return nil, err
	}
	return in.c.Media.Read(uri)
}

func (in *Intent) DownloadMediaToFile(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo, writable bool, callback func(*os.File) error) error {
	data, err := in.DownloadMedia(ctx, uri, file)
	if err != nil {
		return err
	}
	// The connector asked for a file. It holds plaintext, so it goes in memory-backed
	// storage only, lives only as long as the callback, and is removed after. Without
	// memory-backed storage the file is refused rather than written to disk.
	tmp, err := media.TempPlainFile()
	if err != nil {
		clear(data)
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	_, err = tmp.Write(data)
	clear(data)
	if err != nil {
		return err
	}
	if _, err = tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return callback(tmp)
}

func (in *Intent) UploadMedia(ctx context.Context, roomID id.RoomID, data []byte, fileName, mimeType string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	return in.c.Media.Upload(data, fileName, mimeType), nil, nil
}

// UploadMediaStream gives the connector somewhere to write a file. A connector that needs
// a real file (requireFile; WhatsApp casts the writer to *os.File for large media) gets one
// in memory-backed storage; otherwise a buffer. Either way the plaintext ends up only in
// the media store's memory until it is sealed.
func (in *Intent) UploadMediaStream(ctx context.Context, roomID id.RoomID, size int64, requireFile bool, cb bridgev2.FileStreamCallback) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	var data []byte
	var res *bridgev2.FileStreamResult
	var err error
	if requireFile {
		tmp, err := media.TempPlainFile()
		if err != nil {
			return "", nil, err
		}
		defer func() {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}()
		if res, err = cb(tmp); err != nil {
			return "", nil, err
		}
		if _, err = tmp.Seek(0, io.SeekStart); err != nil {
			return "", nil, err
		}
		if data, err = io.ReadAll(tmp); err != nil {
			return "", nil, err
		}
	} else {
		var buf bytes.Buffer
		if res, err = cb(&buf); err != nil {
			return "", nil, err
		}
		data = buf.Bytes()
	}
	if res.ReplacementFile != "" {
		replacement := res.ReplacementFile
		defer func() { _ = os.Remove(replacement) }()
		clear(data)
		if data, err = os.ReadFile(replacement); err != nil {
			return "", nil, err
		}
	}
	uri := in.c.Media.Upload(data, res.FileName, res.MimeType)
	clear(data)
	return uri, nil, nil
}

func (in *Intent) SetDisplayName(ctx context.Context, name string) error {
	if in.kind != intentGhost {
		return nil
	}
	return in.c.ghostProfileChanged(ctx, in.ghostID, &name, nil)
}

func (in *Intent) SetAvatarURL(ctx context.Context, avatarURL id.ContentURIString) error {
	if in.kind != intentGhost {
		return nil
	}
	return in.c.ghostProfileChanged(ctx, in.ghostID, nil, &avatarURL)
}

func (in *Intent) SetExtraProfileMeta(ctx context.Context, data any) error { return nil }
func (in *Intent) SetProfile(ctx context.Context, data any) error          { return nil }

// CreateRoom records a portal and its members. The room ID is the deterministic one
// bridgev2 asked for, which encodes the portal key.
func (in *Intent) CreateRoom(ctx context.Context, req *mautrix.ReqCreateRoom) (id.RoomID, error) {
	roomID := req.BeeperLocalRoomID
	if roomID == "" {
		// Not a portal (for example a management room). Nothing reads it.
		return id.RoomID("!local_" + string(ids.LocalEventID("room", strconv.FormatInt(time.Now().UnixNano(), 10)))[1:] + ":" + ids.ServerName), nil
	}
	members := append(append([]id.UserID{}, req.BeeperInitialMembers...), req.Invite...)
	// Recorded only: the collage is chosen once they're all in.
	for _, member := range members {
		if _, err := in.c.recordMembership(ctx, roomID, member, event.MembershipJoin); err != nil {
			return "", err
		}
	}
	kind := "group"
	if req.IsDirect {
		kind = "dm"
	} else if req.CreationContent["type"] == event.RoomTypeSpace {
		kind = "space"
	}
	override := chatOverride{kind: kind, initialState: req.InitialState}
	// bridgev2 saves the portal's room only after this returns, so the database can't say yet
	// who a direct chat is with; the portal it is creating the room for can. This runs on that
	// portal's own loop, the only one that changes it.
	if req.IsDirect {
		if key, ok := ids.ParseRoomID(roomID); ok {
			if portal, err := in.c.Bridge.GetExistingPortalByKey(ctx, key); err == nil && portal != nil {
				override.otherUser = portal.OtherUserID
			}
		}
	}
	if err := in.c.emitChat(ctx, roomID, override); err != nil && !errors.Is(err, errNotPortal) {
		return "", err
	}
	if kind != "dm" {
		// After the chat, which the collage belongs to. bridgev2 hasn't saved the portal yet,
		// so it's said here that this is a group.
		in.c.refreshCollageOrLog(ctx, roomID, collageChange{group: true})
	}
	return roomID, nil
}

func (in *Intent) DeleteRoom(ctx context.Context, roomID id.RoomID, puppetsOnly bool) error {
	// bridgev2 reports no outcome for a command in a chat it has deleted, so a command still
	// out there must not hold the chat any longer. Found by room alone: the login may be gone.
	if portalID, err := in.c.portalOpaqueForRoom(ctx, roomID); err == nil {
		in.c.releaseDeletedChat(portalID)
	}
	o, err := in.c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return nil
	} else if err != nil {
		return err
	}
	sealed, err := in.c.seal(ctx, o, seal.KindChat, o.portalID, protocol.ChatPlaintext{})
	if err != nil {
		return err
	}
	return in.c.emit(ctx, &protocol.Event{
		Type: protocol.EventChat, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID,
		Kind: "group", Sealed: sealed, Deleted: true,
	})
}

func (in *Intent) EnsureJoined(ctx context.Context, roomID id.RoomID, params ...bridgev2.EnsureJoinedParams) error {
	return in.c.setMembership(ctx, roomID, in.mxid, event.MembershipJoin)
}

func (in *Intent) EnsureInvited(ctx context.Context, roomID id.RoomID, userID id.UserID) error {
	return in.c.setMembership(ctx, roomID, userID, event.MembershipJoin)
}

func (in *Intent) TagRoom(ctx context.Context, roomID id.RoomID, tag event.RoomTag, isTagged bool) error {
	return nil
}

func (in *Intent) MuteRoom(ctx context.Context, roomID id.RoomID, until time.Time) error { return nil }

// GetEvent can't work: event content is sealed and the bridge host keeps no copy. The
// WhatsApp connector uses it only to recover a media caption's previous version when it is
// edited, and logs and carries on when it fails.
func (in *Intent) GetEvent(ctx context.Context, roomID id.RoomID, eventID id.EventID) (*event.Event, error) {
	return nil, errors.New("the Trioditis bridge host doesn't store event content")
}

// chatOverride carries what bridgev2 is changing right now, which may not be in the
// database yet.
type chatOverride struct {
	kind         string
	eventType    event.Type
	content      *event.Content
	initialState []*event.Event
	// request, if set, is whether the chat is a message request, from bridge info bridgev2
	// is sending now.
	request *bool
	// otherUser, if set, is who a direct chat is with, before the database has it.
	otherUser networkid.UserID
}

func roomKind(roomType database.RoomType) string {
	switch roomType {
	case database.RoomTypeDM:
		return "dm"
	case database.RoomTypeSpace:
		return "space"
	default:
		return "group"
	}
}

// emitChat seals a chat's full metadata as an upsert.
func (c *Connector) emitChat(ctx context.Context, roomID id.RoomID, override chatOverride) error {
	o, err := c.owner(ctx, roomID)
	if err != nil {
		return err
	}
	// By room, not key: the key changes when the network re-IDs the portal; the room doesn't.
	portal, err := c.Bridge.DB.Portal.GetByMXID(ctx, roomID)
	if err != nil {
		return err
	}
	var plain protocol.ChatPlaintext
	var avatarURL id.ContentURIString
	kind := override.kind
	var parentKey networkid.PortalKey
	var parentRoom id.RoomID
	var request bool
	otherUser := override.otherUser
	if portal != nil {
		plain.Name, plain.Topic, avatarURL = portal.Name, portal.Topic, portal.AvatarMXC
		request = portal.MessageRequest
		if otherUser == "" {
			otherUser = portal.OtherUserID
		}
		if kind == "" {
			kind = roomKind(portal.RoomType)
		}
		if portal.ParentKey.ID != "" {
			parentKey = portal.ParentKey
		}
	}
	apply := func(eventType event.Type, content *event.Content) {
		if content.Parsed == nil && content.VeryRaw != nil {
			_ = content.ParseRaw(eventType)
		}
		switch parsed := content.Parsed.(type) {
		case *event.RoomNameEventContent:
			plain.Name = parsed.Name
		case *event.TopicEventContent:
			plain.Topic = parsed.Topic
		case *event.RoomAvatarEventContent:
			avatarURL = parsed.URL
		case *event.BridgeEventContent:
			request = parsed.Channel.MessageRequest
		case *event.SpaceParentEventContent:
		}
	}
	for _, evt := range override.initialState {
		apply(evt.Type, &evt.Content)
		if evt.Type == event.StateSpaceParent && evt.StateKey != nil {
			if _, ok := ids.ParseRoomID(id.RoomID(*evt.StateKey)); ok {
				parentRoom = id.RoomID(*evt.StateKey)
			}
		}
	}
	if override.content != nil {
		apply(override.eventType, override.content)
	}
	if override.request != nil {
		request = *override.request
	}
	if kind == "" {
		kind = "group"
	}
	if avatarURL != "" {
		if att := c.avatarFor(ctx, avatarURL, o.userID); att != nil {
			plain.Avatar = att
		} else {
			// The avatar exists but neither its upload nor a kept reference is left (an avatar
			// from before references were kept). Saying so keeps clients from taking a name
			// change as the avatar's removal.
			plain.AvatarUnchanged = true
		}
	}
	// Who a direct chat is with, so a client can show their profile and put their chats on
	// every network together. Opaque, as every ghostId is, and sealed with the rest.
	if kind == "dm" && otherUser != "" {
		if plain.DMGhostID, err = c.ghostOpaque(ctx, otherUser); err != nil {
			return err
		}
	}
	fitChat(&plain)
	sealed, err := c.seal(ctx, o, seal.KindChat, o.portalID, plain)
	if err != nil {
		return err
	}
	evt := &protocol.Event{
		Type: protocol.EventChat, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID, Kind: kind, Sealed: sealed,
	}
	if parentRoom != "" {
		if evt.ParentPortalID, err = c.portalOpaqueForRoom(ctx, parentRoom); err != nil {
			return err
		}
	} else if parentKey.ID != "" {
		if evt.ParentPortalID, err = c.portalOpaqueForKey(ctx, parentKey); err != nil {
			return err
		}
	}
	state, sent, err := c.requestState(ctx, o, request)
	if err != nil {
		return err
	}
	evt.IsRequest = state
	if err = c.emit(ctx, evt); err != nil {
		return err
	}
	sent()
	return nil
}

// DescribeDirectChats describes every direct chat again, once per database, so a chat
// described before chat metadata said who a direct chat is with gets its dmGhostId. A chat
// whose login is gone is left out. Any other failure leaves it to be tried again at the next
// start, from the beginning: describing a chat twice changes nothing.
func (c *Connector) DescribeDirectChats(ctx context.Context) error {
	if done, err := c.Store.DescribedDirectChats(ctx); err != nil || done {
		return err
	}
	portals, err := c.Bridge.DB.Portal.GetAllWithMXID(ctx)
	if err != nil {
		return err
	}
	failed := 0
	sent := map[id.RoomID]describedAs{}
	for _, portal := range portals {
		if err = ctx.Err(); err != nil {
			return err
		}
		if portal.RoomType != database.RoomTypeDM || portal.OtherUserID == "" {
			continue
		}
		// Only a chat whose login is gone, or isn't a Trioditis user's, is left out for good:
		// anything else that fails is tried again at the next start.
		key, ok := ids.ParseRoomID(portal.MXID)
		if !ok || key.Receiver == "" {
			continue
		}
		login, err := c.Bridge.DB.UserLogin.GetByID(ctx, key.Receiver)
		if err != nil {
			failed++
			continue
		} else if login == nil {
			continue
		} else if _, ok = ids.ParseUserMXID(login.UserMXID); !ok {
			continue
		}
		if err = c.emitChat(ctx, portal.MXID, chatOverride{}); err != nil && !errors.Is(err, errNotPortal) {
			failed++
		} else if err == nil {
			sent[portal.MXID] = describedAsOf(portal)
		}
	}
	// bridgev2 sends a chat's new name or picture before it saves it, so one changing while this
	// ran could have been described from the database's older copy after its new one went out.
	// Once such a change has had time to be saved, a chat whose saved copy differs from the one
	// it was described from is described again, from the saved one.
	settle := c.DescribeSettle
	if settle == 0 {
		settle = 5 * time.Second
	}
	if len(sent) > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(settle):
		}
	}
	for roomID, was := range sent {
		portal, err := c.Bridge.DB.Portal.GetByMXID(ctx, roomID)
		if err != nil {
			failed++
		} else if portal != nil && describedAsOf(portal) != was {
			if err = c.emitChat(ctx, roomID, chatOverride{}); err != nil && !errors.Is(err, errNotPortal) {
				failed++
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d direct chats couldn't be described again", failed)
	}
	return c.Store.SetDescribedDirectChats(ctx)
}

// describedAs is what a chat's description is made from, as the database has it.
type describedAs struct {
	name, topic string
	avatar      id.ContentURIString
	otherUser   networkid.UserID
	request     bool
}

func describedAsOf(p *database.Portal) describedAs {
	return describedAs{p.Name, p.Topic, p.AvatarMXC, p.OtherUserID, p.MessageRequest}
}

// ensureContact sends a ghost's profile to a person the first time the ghost appears in
// one of their chats. Profiles go only to people who share a chat with the ghost. The
// membership is the claim to send it: recorded first, so a profile update meanwhile reaches the
// person too, and taken back if sending fails, so the next time tries again. Then, where the
// ghost's ID is their phone number, that number, once for each of the person's logins.
func (c *Connector) ensureContact(ctx context.Context, o *owner, ghost networkid.UserID) error {
	room, mxid := contactRoom(o.userID), string(ids.GhostMXID(ghost))
	added, err := c.Store.AddMember(ctx, room, mxid)
	if err != nil {
		return err
	}
	if added {
		if err = c.emitContact(ctx, o, ghost, nil, nil); err != nil {
			c.unclaim(ctx, room, mxid)
			return err
		}
	}
	return c.ensureNumber(ctx, o, ghost)
}

// ensureNumber sends the phone number a contact's ID is to the person, the first time one of
// their logins sees the contact: each login's is its own (numbersRoom), since the number is
// what that login's chats gave it. It's journaled before it's marked sent, so a failure or a
// stop in between sends it again with the contact's next message, never not at all; sending it
// twice is harmless, since a login's identifiers replace its own.
func (c *Connector) ensureNumber(ctx context.Context, o *owner, ghost networkid.UserID) error {
	number := numberID(ghost)
	if !numberIDNetworks[c.Network] || number == "" {
		return nil
	}
	// The marker names the contact by its opaque ID: their Matrix ID would be their number.
	ghostID, err := c.ghostOpaque(ctx, ghost)
	if err != nil {
		return err
	}
	room, mxid := numbersRoom(o.userID, o.loginID), ghostID
	sent, err := c.Store.IsMember(ctx, room, mxid)
	if err != nil || sent {
		return err
	}
	if err = c.emitContactIdentifiers(ctx, o, ghost, []string{number}); err != nil {
		return err
	}
	_, err = c.Store.AddMember(ctx, room, mxid)
	return err
}

// unclaim takes back a membership recorded for something that then couldn't be sent.
func (c *Connector) unclaim(ctx context.Context, room, mxid string) {
	// Even when ctx was what ended the send: the claim must go, or nothing sends it again.
	if err := c.Store.RemoveMember(context.WithoutCancel(ctx), room, mxid); err != nil {
		c.Log.Err(err).Msg("Taking back a contact's claim failed; it won't be sent again until it changes")
	}
}

// numbersRoom records which contacts' numbers a person's login has sent.
func numbersRoom(userID, loginID string) string { return "numbers:" + userID + ":" + loginID }

func contactRoom(userID string) string { return "contacts:" + userID }

func (c *Connector) emitContact(ctx context.Context, o *owner, ghost networkid.UserID, name *string, avatar *id.ContentURIString) error {
	var plain protocol.ContactPlaintext
	var avatarURL id.ContentURIString
	dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghost)
	if err != nil {
		return err
	}
	if dbGhost != nil {
		plain.Name, avatarURL = dbGhost.Name, dbGhost.AvatarMXC
		if len(dbGhost.Identifiers) > 0 {
			plain.Handle = dbGhost.Identifiers[0]
		}
	}
	if name != nil {
		plain.Name = *name
	}
	if avatar != nil {
		avatarURL = *avatar
	}
	if avatarURL != "" {
		if att := c.avatarFor(ctx, avatarURL, o.userID); att != nil {
			plain.Avatar = att
		} else {
			plain.AvatarUnchanged = true
		}
	}
	return c.emitContactProfile(ctx, o, ghost, plain)
}

// avatarKind is what a kept avatar reference is sealed as. It is sealed to the bridge key
// only: the bridge host reads it back, nobody else does.
const avatarKind seal.Kind = "avatarRef"

// avatarFor is the owner's sealed copy of an avatar, to put in a chat or contact's metadata.
// An avatar's upload lives only minutes, but its sealed copy stays in the media store, so the
// first copy is kept (sealed to the bridge key) and attached again once the upload is gone:
// otherwise a later change to the name alone would carry no avatar, and a device that never
// saw it would show none. Nil when there is neither.
func (c *Connector) avatarFor(ctx context.Context, uri id.ContentURIString, ownerUserID string) *protocol.Attachment {
	sealCtx := seal.Context{Kind: avatarKind, OwnerUserID: ownerUserID, ObjectID: string(uri)}
	att, err := c.Media.AttachmentFor(uri, ownerUserID)
	if err == nil {
		kept, err := seal.SealJSON(att, []seal.PublicKey{c.BridgeKey.Public}, sealCtx)
		if err == nil {
			err = c.Store.PutAvatarRef(ctx, ownerUserID, string(uri), kept)
		}
		if err != nil {
			// The avatar still goes now; only a later resend of it is lost.
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Keeping an avatar's reference failed")
		}
		return att
	}
	kept, err := c.Store.AvatarRef(ctx, ownerUserID, string(uri))
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's reference failed")
		}
		return nil
	}
	var ref protocol.Attachment
	if err = seal.OpenJSON(kept, c.BridgeKey, sealCtx, &ref); err != nil {
		// Sealed to an earlier bridge key, say: the avatar is left as the client has it.
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("An avatar's reference couldn't be opened")
		return nil
	}
	return &ref
}

// emitContactProfile seals a contact's profile and sends it to the person.
func (c *Connector) emitContactProfile(ctx context.Context, o *owner, ghost networkid.UserID, plain protocol.ContactPlaintext) error {
	ghostID, err := c.ghostOpaque(ctx, ghost)
	if err != nil {
		return err
	}
	// Contacts aren't tied to a chat, so they are sealed to the person only, never to an
	// agent-access key granted for one chat.
	contactOwner := *o
	contactOwner.portalID = ""
	fitContact(&plain)
	sealed, err := c.seal(ctx, &contactOwner, seal.KindContact, ghostID, plain)
	if err != nil {
		return err
	}
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventContact, UserID: o.userID, LoginID: o.loginID, GhostID: ghostID, Sealed: sealed,
	})
}

// numberID is the phone number a contact's ID is, as a tel: URI, or "" for one that isn't a
// number (a WhatsApp LID or bot, which mautrix-whatsapp prefixes).
func numberID(ghost networkid.UserID) string {
	digits := string(ghost)
	if len(digits) < 7 || len(digits) > 15 || strings.Trim(digits, "0123456789") != "" {
		return ""
	}
	return "tel:+" + digits
}

// syncNumbers sends, for each of the person's contacts whose ID is a phone number and who is in
// a chat of this login's, that number: the login's own chats gave it the ID. A contact the
// person knows only through another login is left to that login.
func (c *Connector) syncNumbers(ctx context.Context, o *owner) error {
	members, err := c.Store.Members(ctx, contactRoom(o.userID))
	if err != nil {
		return err
	}
	for _, mxid := range members {
		ghost, ok := ids.ParseGhostMXID(id.UserID(mxid))
		if !ok {
			continue
		}
		number := numberID(ghost)
		if number == "" {
			continue
		}
		seen, err := c.inChatOf(ctx, o.login, mxid)
		if err != nil {
			return err
		} else if !seen {
			continue
		}
		if err = c.emitContactIdentifiers(ctx, o, ghost, []string{number}); err != nil {
			return err
		}
	}
	return nil
}

// inChatOf reports whether a ghost is in one of a login's chats.
func (c *Connector) inChatOf(ctx context.Context, login networkid.UserLoginID, ghostMXID string) (bool, error) {
	rooms, err := c.Store.RoomsOf(ctx, ghostMXID)
	if err != nil {
		return false, err
	}
	for _, room := range rooms {
		if key, ok := ids.ParseRoomID(id.RoomID(room)); ok && key.Receiver == login {
			return true, nil
		}
	}
	return false, nil
}

// emitContactIdentifiers sends what one of the person's logins knows a contact by, sealed to
// that person only and apart from the shared profile (see ContactIdentifiersPlaintext). Each
// login's are their own object (`<ghostId>/identifiers/<loginId>`), so two logins that know a
// contact differently don't overwrite each other, and an empty list clears that login's.
func (c *Connector) emitContactIdentifiers(ctx context.Context, o *owner, ghost networkid.UserID, identifiers []string) error {
	ghostID, err := c.ghostOpaque(ctx, ghost)
	if err != nil {
		return err
	}
	plain := protocol.ContactIdentifiersPlaintext{Identifiers: fitIdentifiers(identifiers)}
	contactOwner := *o
	contactOwner.portalID = ""
	sealed, err := c.seal(ctx, &contactOwner, seal.KindContact, ghostID+"/identifiers/"+o.loginID, plain)
	if err != nil {
		return err
	}
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventContactIdentifiers, UserID: o.userID, LoginID: o.loginID, GhostID: ghostID, Sealed: sealed,
	})
}

// ghostProfileChanged sends a ghost's new profile to everyone who has them as a contact.
func (c *Connector) ghostProfileChanged(ctx context.Context, ghost networkid.UserID, name *string, avatar *id.ContentURIString) error {
	rooms, err := c.Store.RoomsOf(ctx, string(ids.GhostMXID(ghost)))
	if err != nil {
		return err
	}
	seen := make(map[string]bool)
	for _, room := range rooms {
		if seen[room] {
			continue
		}
		seen[room] = true
		if len(room) < len("contacts:") || room[:len("contacts:")] != "contacts:" {
			continue
		}
		userID := room[len("contacts:"):]
		// Find one of the person's logins on this network that shares a chat with the
		// ghost, for the event's loginId.
		o, err := c.anyOwnerFor(ctx, userID, ghost)
		if err != nil {
			return err
		} else if o == nil {
			continue
		}
		if err = c.emitContact(ctx, o, ghost, name, avatar); err != nil {
			return err
		}
	}
	if avatar != nil {
		c.pictureChanged(ctx, ghost, *avatar != "", rooms)
	}
	return nil
}

func (c *Connector) anyOwnerFor(ctx context.Context, userID string, ghost networkid.UserID) (*owner, error) {
	rooms, err := c.Store.RoomsOf(ctx, string(ids.GhostMXID(ghost)))
	if err != nil {
		return nil, err
	}
	for _, room := range rooms {
		o, err := c.owner(ctx, id.RoomID(room))
		if errors.Is(err, errNotPortal) {
			continue
		} else if err != nil {
			return nil, err
		}
		if o.userID == userID {
			return o, nil
		}
	}
	return nil, nil
}

// Chat and contact metadata is sealed into at most 8 KiB (the backend quarantines more), so
// a name, handle or topic that long is cut short, at a character boundary. These caps come
// first; then what is actually sealed is measured, since JSON escaping can make a short
// string several times longer (a control character takes six bytes).
const (
	maxNameBytes  = 512
	maxTopicBytes = 4096
)

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// sealedSize is how many bytes of ciphertext v seals to: its JSON (as seal.SealJSON encodes
// it) plus the authentication tag.
func sealedSize(v any) int {
	data, err := json.Marshal(v)
	if err != nil {
		return math.MaxInt
	}
	n := len(data)
	clear(data)
	return n + chacha20poly1305.Overhead
}

// longestFitting is the longest prefix of s, cut at a character boundary, that fits says
// fits. A longer prefix never serializes shorter, so a binary search finds it.
func longestFitting(s string, fits func(string) bool) string {
	if fits(s) {
		return s
	}
	lo, hi := 0, len(s)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if fits(truncateUTF8(s, mid)) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return truncateUTF8(s, lo)
}

// fitMessage cuts a message down until it seals within the backend's limit for a message
// or edit, so it is stored rather than quarantined: first the formatted body goes, then
// over-long attachment names, then link previews, then the body is cut short, and last the
// mentions. Anything cut is marked `truncated` in the plaintext.
func fitMessage(plain *protocol.MessagePlaintext) *protocol.MessagePlaintext {
	fits := func() bool { return sealedSize(plain) <= protocol.MaxMessageSealedBytes }
	if fits() {
		return plain
	}
	plain.Truncated, plain.HTML = true, ""
	for i := range plain.Attachments {
		plain.Attachments[i].Name = truncateUTF8(plain.Attachments[i].Name, maxNameBytes)
	}
	if fits() {
		return plain
	}
	// The links are still in the body; a preview is only a nicer way to show them.
	plain.Previews = nil
	if fits() {
		return plain
	}
	plain.Body = longestFitting(plain.Body, func(body string) bool { plain.Body = body; return fits() })
	if !fits() {
		plain.Mentions = nil
	}
	return plain
}

// fitChat cuts a chat's metadata until it seals within 8 KiB: the topic first, then the name.
func fitChat(plain *protocol.ChatPlaintext) {
	plain.Name, plain.Topic = truncateUTF8(plain.Name, maxNameBytes), truncateUTF8(plain.Topic, maxTopicBytes)
	if plain.Avatar != nil {
		plain.Avatar.Name = truncateUTF8(plain.Avatar.Name, maxNameBytes)
	}
	fits := func() bool { return sealedSize(plain) <= protocol.MaxMetadataSealedBytes }
	if !fits() {
		plain.Topic = longestFitting(plain.Topic, func(topic string) bool { plain.Topic = topic; return fits() })
	}
	if !fits() {
		plain.Name = longestFitting(plain.Name, func(name string) bool { plain.Name = name; return fits() })
	}
}

// maxIdentifiers is the most identifiers a contact keeps: more numbers and usernames than
// anyone has, but a bound on what one network can make the host seal.
const maxIdentifiers = 32

// fitIdentifiers keeps the identifiers that seal within 8 KiB, dropping the last ones first.
// Each is kept whole or not at all, since a cut phone number or username names someone else.
func fitIdentifiers(identifiers []string) []string {
	out := make([]string, 0, min(len(identifiers), maxIdentifiers))
	for _, ident := range identifiers {
		if ident != "" && len(ident) <= maxNameBytes && !slices.Contains(out, ident) && len(out) < maxIdentifiers {
			out = append(out, ident)
		}
	}
	for len(out) > 0 && sealedSize(protocol.ContactIdentifiersPlaintext{Identifiers: out}) > protocol.MaxMetadataSealedBytes {
		out = out[:len(out)-1]
	}
	return out
}

// fitContact cuts a contact's profile until it seals within 8 KiB: the handle first, then
// the name.
func fitContact(plain *protocol.ContactPlaintext) {
	plain.Name, plain.Handle = truncateUTF8(plain.Name, maxNameBytes), truncateUTF8(plain.Handle, maxNameBytes)
	if plain.Avatar != nil {
		plain.Avatar.Name = truncateUTF8(plain.Avatar.Name, maxNameBytes)
	}
	fits := func() bool { return sealedSize(plain) <= protocol.MaxMetadataSealedBytes }
	if !fits() {
		plain.Handle = longestFitting(plain.Handle, func(handle string) bool { plain.Handle = handle; return fits() })
	}
	if !fits() {
		plain.Name = longestFitting(plain.Name, func(name string) bool { plain.Name = name; return fits() })
	}
}

package connector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"go.mau.fi/util/variationselector"

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

func (in *Intent) SendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
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
		eventID = ids.ReactionEventID(r.Room, r.MessageID, r.MessagePartID, r.SenderID, r.EmojiID)
	default:
		eventID = ids.LocalEventID(string(roomID), string(in.mxid), eventType.Type, strconv.FormatInt(ts.UnixNano(), 10), digest(content))
	}
	s, ok := in.sender()
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
			sealed, err := c.seal(ctx, o, seal.KindMessage, string(eventID), c.messagePlaintext(ctx, o, eventType, newContent))
			if err != nil {
				return err
			}
			base.Type, base.EventID, base.TargetEventID, base.Sealed = protocol.EventEdit, string(eventID), string(target), sealed
			return c.emit(ctx, &base)
		}
		sealed, err := c.seal(ctx, o, seal.KindMessage, string(eventID), c.messagePlaintext(ctx, o, eventType, msg))
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
		return c.emit(ctx, &base)
	case event.EventReaction:
		reaction, ok := content.Parsed.(*event.ReactionEventContent)
		if !ok {
			return fmt.Errorf("unexpected %T for reaction", content.Parsed)
		}
		base.Type, base.EventID, base.TargetEventID, base.Key = protocol.EventReaction, string(eventID), string(reaction.RelatesTo.EventID), reactionKey(reaction.RelatesTo.Key)
		if err = c.Store.PutReaction(ctx, base.EventID, base.TargetEventID, base.Key); err != nil {
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
		att, err := c.Media.AttachmentFor(msg.URL, o.userID)
		if err != nil {
			c.Log.Warn().Err(err).Msg("Attachment isn't available to seal; sending the message without it")
		} else {
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
			plain.Attachments = []protocol.Attachment{*att}
		}
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
	return plain
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
	default:
		return resp, nil
	}
}

func (c *Connector) setMembership(ctx context.Context, roomID id.RoomID, mxid id.UserID, membership event.Membership) error {
	switch membership {
	case event.MembershipJoin, event.MembershipInvite:
		added, err := c.Store.AddMember(ctx, string(roomID), string(mxid))
		if err != nil || !added {
			return err
		}
		if ghost, ok := ids.ParseGhostMXID(mxid); ok {
			o, err := c.owner(ctx, roomID)
			if errors.Is(err, errNotPortal) {
				return nil
			} else if err != nil {
				return err
			}
			return c.ensureContact(ctx, o, ghost)
		}
		return nil
	case event.MembershipLeave, event.MembershipBan:
		return c.Store.RemoveMember(ctx, string(roomID), string(mxid))
	default:
		return nil
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
	if file != nil {
		uri = file.URL
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
	for _, member := range members {
		if err := in.c.setMembership(ctx, roomID, member, event.MembershipJoin); err != nil {
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
	if err := in.c.emitChat(ctx, roomID, override); err != nil && !errors.Is(err, errNotPortal) {
		return "", err
	}
	return roomID, nil
}

func (in *Intent) DeleteRoom(ctx context.Context, roomID id.RoomID, puppetsOnly bool) error {
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
	if portal != nil {
		plain.Name, plain.Topic, avatarURL = portal.Name, portal.Topic, portal.AvatarMXC
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
	if kind == "" {
		kind = "group"
	}
	if avatarURL != "" {
		if att, err := c.Media.AttachmentFor(avatarURL, o.userID); err == nil {
			plain.Avatar = att
		} else {
			// The avatar exists but its upload is gone (it expired, or the host restarted).
			// Saying so keeps clients from taking a name change as the avatar's removal.
			plain.AvatarUnchanged = true
		}
	}
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
	return c.emit(ctx, evt)
}

// ensureContact sends a ghost's profile to a person the first time the ghost appears in
// one of their chats. Profiles go only to people who share a chat with the ghost.
func (c *Connector) ensureContact(ctx context.Context, o *owner, ghost networkid.UserID) error {
	added, err := c.Store.AddMember(ctx, contactRoom(o.userID), string(ids.GhostMXID(ghost)))
	if err != nil || !added {
		return err
	}
	return c.emitContact(ctx, o, ghost, nil, nil)
}

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
		if att, err := c.Media.AttachmentFor(avatarURL, o.userID); err == nil {
			plain.Avatar = att
		} else {
			plain.AvatarUnchanged = true
		}
	}
	ghostID, err := c.ghostOpaque(ctx, ghost)
	if err != nil {
		return err
	}
	// Contacts aren't tied to a chat, so they are sealed to the person only, never to an
	// agent-access key granted for one chat.
	contactOwner := *o
	contactOwner.portalID = ""
	sealed, err := c.seal(ctx, &contactOwner, seal.KindContact, ghostID, plain)
	if err != nil {
		return err
	}
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventContact, UserID: o.userID, LoginID: o.loginID, GhostID: ghostID, Sealed: sealed,
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

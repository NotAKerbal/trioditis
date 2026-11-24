package imessage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"time"

	"go.mau.fi/util/jsontime"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// Every send here is made once, and only through the Private API. BlueBubbles' other way of
// sending, scripting the Messages app, runs the script again when it times out and then
// falls back to a second script (actions.ts, sendMessage), so one request can send a message
// twice; its Private API path asks Messages once. Without the Private API, nothing is sent:
// each send is refused before anything goes. The client never retries or follows a redirect,
// and an outcome that isn't certain is left uncertain, so the bridge host records the send as
// unknown and the person decides.

var (
	errNeedsPrivateAPI = bridgev2.WrapErrorInStatus(errors.New("imessage: this needs BlueBubbles' Private API on the Mac")).
				WithIsCertain(true).WithErrorReason(event.MessageStatusUnsupported).WithSendNotice(true)
	errNewChatText = bridgev2.WrapErrorInStatus(errors.New("imessage: a new chat starts with a text")).
			WithIsCertain(true).WithErrorReason(event.MessageStatusUnsupported).WithSendNotice(true)
	errUnsupported = bridgev2.WrapErrorInStatus(errors.New("imessage: iMessage can't send that")).
			WithIsCertain(true).WithErrorReason(event.MessageStatusUnsupported).WithSendNotice(true)
	errUnconfirmed  = errors.New("imessage: the Mac didn't confirm the change")
	errNoGUID       = errors.New("imessage: the Mac's answer named no message")
	errMarkedFailed = bridgev2.WrapErrorInStatus(errors.New("imessage: Messages marked the message as not delivered")).
			WithIsCertain(true).WithErrorReason(event.MessageStatusGenericError)
)

// canSend says whether the Mac can send: its Private API helper is running. When it last
// wasn't, the server is asked again first, since the helper may have started since.
func (c *Client) canSend(ctx context.Context) bool {
	if c.privateAPI.Load() {
		return true
	}
	if err := c.refreshInfo(ctx); err != nil {
		return false
	}
	return c.privateAPI.Load()
}

// sentMessage checks what the Mac answered a send with: a message Messages marked failed
// certainly didn't go, and an answer naming no message can't be matched to its echo.
func sentMessage(sent *bluebubbles.Message) (*bluebubbles.Message, error) {
	switch {
	case sent == nil || sent.GUID == "":
		return nil, errNoGUID
	case sent.Error != 0:
		return nil, errMarkedFailed
	}
	return sent, nil
}

// sendError is how a failed request is reported: certain when the server refused it before
// acting, or the connection never opened, and otherwise left as it is, which bridgev2
// reports as uncertain.
func sendError(err error) error {
	var bbErr *bluebubbles.Error
	switch {
	case errors.As(err, &bbErr) && bbErr.NeedsPrivateAPI():
		return errNeedsPrivateAPI
	case errors.As(err, &bbErr) && bbErr.Certain():
		reason := event.MessageStatusGenericError
		if bbErr.Unauthorized() {
			reason = event.MessageStatusBridgeUnavailable
		}
		return bridgev2.WrapErrorInStatus(err).WithIsCertain(true).WithErrorReason(reason)
	case notSent(err):
		return bridgev2.WrapErrorInStatus(err).WithIsCertain(true).WithErrorReason(event.MessageStatusNetworkError)
	}
	return err
}

// notSent says a request failed before any of it was written: its connection was refused,
// or was never made.
func notSent(err error) bool {
	if errors.Is(err, bluebubbles.ErrAddressRefused) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

func newTempGUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "trioditis-" + hex.EncodeToString(b[:])
}

// chatGUID is the GUID Messages has for a portal's chat, or "" when Messages has no such chat
// yet (a direct chat started from Trioditis). The server matches a sent message to its chat
// by Messages' own GUID, so sends are made to that rather than to the "any" form.
func (c *Client) chatGUID(ctx context.Context, portal *bridgev2.Portal) (string, error) {
	chat, err := c.bb.Chat(ctx, string(portal.ID))
	var bbErr *bluebubbles.Error
	if errors.As(err, &bbErr) && bbErr.NotFound() {
		return "", nil
	} else if err != nil {
		return "", sendError(err)
	}
	return chat.GUID, nil
}

func (c *Client) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	if c.bb == nil {
		return nil, bridgev2.ErrNotLoggedIn
	}
	if !c.canSend(ctx) {
		return nil, errNeedsPrivateAPI
	}
	content := msg.Content
	var replyTo string
	if msg.ReplyTo != nil {
		replyTo = string(msg.ReplyTo.ID)
	}
	chat, err := c.chatGUID(ctx, msg.Portal)
	if err != nil {
		return nil, err
	}
	var sent *bluebubbles.Message
	part := textPart
	switch content.MsgType {
	case event.MsgText, event.MsgNotice, event.MsgEmote:
		text := content.Body
		if content.MsgType == event.MsgEmote {
			text = "* " + text
		}
		sent, err = c.sendText(ctx, msg.Portal, chat, text, replyTo)
	case event.MsgImage, event.MsgVideo, event.MsgAudio, event.MsgFile:
		if chat == "" {
			return nil, errNewChatText
		}
		part = "a0"
		sent, err = c.sendFile(ctx, chat, content, replyTo)
	default:
		return nil, errUnsupported
	}
	if err != nil {
		return nil, err
	}
	if sent, err = sentMessage(sent); err != nil {
		return nil, err
	}
	at := time.Now()
	if sent.DateCreated > 0 {
		at = time.UnixMilli(sent.DateCreated)
	}
	return &bridgev2.MatrixMessageResponse{
		DB: &database.Message{
			ID:        networkid.MessageID(sent.GUID),
			PartID:    part,
			SenderID:  c.selfID(),
			Timestamp: at,
			Metadata:  &MessageMetadata{},
		},
		StreamOrder: at.UnixMilli(),
	}, nil
}

func (c *Client) sendText(ctx context.Context, portal *bridgev2.Portal, chat, text, replyTo string) (*bluebubbles.Message, error) {
	if strings.TrimSpace(text) == "" {
		return nil, errUnsupported
	}
	if chat == "" {
		// Messages has no chat with them yet: it is made by sending its first message.
		address := dmAddress(portal.ID)
		if address == "" || replyTo != "" {
			return nil, errUnsupported
		}
		sent, err := c.bb.NewChat(ctx, address, newTempGUID(), text, bluebubbles.MethodPrivateAPI)
		if err != nil {
			return nil, sendError(err)
		}
		return sent, nil
	}
	sent, err := c.bb.SendText(ctx, bluebubbles.TextMessage{
		ChatGUID: chat, TempGUID: newTempGUID(), Message: text, Method: bluebubbles.MethodPrivateAPI, SelectedMessageGUID: replyTo,
	})
	if err != nil {
		return nil, sendError(err)
	}
	return sent, nil
}

func (c *Client) sendFile(ctx context.Context, chat string, content *event.MessageEventContent, replyTo string) (*bluebubbles.Message, error) {
	caption := content.GetCaption()
	name := content.FileName
	if name == "" {
		name = content.Body
	}
	name = safeFileName(name)
	data, err := c.conn.bridge.Bot.DownloadMedia(ctx, content.URL, content.File)
	if err != nil {
		return nil, bridgev2.WrapErrorInStatus(err).WithIsCertain(true).WithErrorReason(event.MessageStatusGenericError)
	}
	if caption != "" {
		// The file and its caption go as one message. Uploading first puts the file on the Mac
		// and sends nothing.
		path, err := c.bb.Upload(ctx, name, data)
		if err != nil {
			var bbErr *bluebubbles.Error
			if errors.As(err, &bbErr) && bbErr.NeedsPrivateAPI() {
				return nil, errNeedsPrivateAPI
			}
			// Whatever became of the upload, nothing was sent.
			return nil, bridgev2.WrapErrorInStatus(err).WithIsCertain(true).WithErrorReason(event.MessageStatusGenericError)
		}
		sent, err := c.bb.SendMultipart(ctx, chat, newTempGUID(), replyTo, []bluebubbles.MultipartPart{
			{PartIndex: 0, Attachment: path, Name: name},
			{PartIndex: 1, Text: caption},
		})
		if err != nil {
			return nil, sendError(err)
		}
		return sent, nil
	}
	sent, err := c.bb.SendFile(ctx, bluebubbles.FileMessage{
		ChatGUID: chat, TempGUID: newTempGUID(), Name: name, Data: data, Method: bluebubbles.MethodPrivateAPI, SelectedMessageGUID: replyTo,
	})
	if err != nil {
		return nil, sendError(err)
	}
	return sent, nil
}

// safeFileName is a file name the server takes: a name, not a path.
func safeFileName(name string) string {
	name = strings.TrimSpace(name)
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

func (c *Client) HandleMatrixEdit(ctx context.Context, msg *bridgev2.MatrixEdit) error {
	if c.bb == nil {
		return bridgev2.ErrNotLoggedIn
	}
	if !c.canSend(ctx) {
		return errNeedsPrivateAPI
	}
	if msg.EditTarget.PartID != textPart {
		return errUnsupported
	}
	before := int64(0)
	if meta, ok := msg.EditTarget.Metadata.(*MessageMetadata); ok {
		before = meta.EditedAt
	}
	edited, err := c.bb.Edit(ctx, string(msg.EditTarget.ID), msg.Content.Body)
	if err != nil {
		return sendError(err)
	}
	// The server answers after 30 seconds even if the edit never showed: it may still.
	if edited.DateEdited <= before {
		return errUnconfirmed
	}
	// Its echo, the message updated with this edit, is then recognized as already applied.
	msg.EditTarget.Metadata = &MessageMetadata{EditedAt: edited.DateEdited}
	return nil
}

func (c *Client) HandleMatrixMessageRemove(ctx context.Context, msg *bridgev2.MatrixMessageRemove) error {
	if c.bb == nil {
		return bridgev2.ErrNotLoggedIn
	}
	if !c.canSend(ctx) {
		return errNeedsPrivateAPI
	}
	unsent, err := c.bb.Unsend(ctx, string(msg.TargetMessage.ID))
	if err != nil {
		return sendError(err)
	}
	if !unsent.Unsent() {
		return errUnconfirmed
	}
	return nil
}

// tapbackName is the tapback an emoji stands for, if it is one of the six.
func tapbackName(emoji string) string {
	emoji = strings.TrimSuffix(emoji, "️")
	switch emoji {
	case "❤", "♥", "😍", "🥰":
		return "love"
	case "👍":
		return "like"
	case "👎":
		return "dislike"
	case "😂", "🤣", "😆":
		return "laugh"
	case "‼", "❗", "❕":
		return "emphasize"
	case "❓", "❔", "?":
		return "question"
	}
	return ""
}

func (c *Client) PreHandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (bridgev2.MatrixReactionPreResponse, error) {
	name := tapbackName(msg.Content.RelatesTo.Key)
	if name == "" {
		return bridgev2.MatrixReactionPreResponse{}, errUnsupported
	}
	// One tapback per person per message: a new one replaces theirs.
	return bridgev2.MatrixReactionPreResponse{SenderID: c.selfID(), Emoji: tapbackEmoji[name], MaxReactions: 1}, nil
}

func (c *Client) HandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (*database.Reaction, error) {
	if c.bb == nil {
		return nil, bridgev2.ErrNotLoggedIn
	}
	if !c.canSend(ctx) {
		return nil, errNeedsPrivateAPI
	}
	chat, err := c.chatGUID(ctx, msg.Portal)
	if err != nil {
		return nil, err
	} else if chat == "" {
		return nil, errUnsupported
	}
	if _, err = c.bb.React(ctx, chat, string(msg.TargetMessage.ID), tapbackName(msg.PreHandleResp.Emoji)); err != nil {
		return nil, sendError(err)
	}
	return &database.Reaction{}, nil
}

func (c *Client) HandleMatrixReactionRemove(ctx context.Context, msg *bridgev2.MatrixReactionRemove) error {
	if c.bb == nil {
		return bridgev2.ErrNotLoggedIn
	}
	if !c.canSend(ctx) {
		return errNeedsPrivateAPI
	}
	name := tapbackName(msg.TargetReaction.Emoji)
	if name == "" {
		return errUnsupported
	}
	chat, err := c.chatGUID(ctx, msg.Portal)
	if err != nil {
		return err
	} else if chat == "" {
		return errUnsupported
	}
	if _, err = c.bb.React(ctx, chat, string(msg.TargetReaction.MessageID), "-"+name); err != nil {
		return sendError(err)
	}
	return nil
}

// HandleMatrixReadReceipt marks the chat read on the Mac, which tells the other person where
// they have read receipts on. Without the Private API, the Mac can't.
func (c *Client) HandleMatrixReadReceipt(ctx context.Context, msg *bridgev2.MatrixReadReceipt) error {
	if c.bb == nil || !c.privateAPI.Load() {
		return nil
	}
	chat, err := c.chatGUID(ctx, msg.Portal)
	if err != nil || chat == "" {
		return err
	}
	return c.bb.MarkRead(ctx, chat)
}

func (c *Client) HandleMatrixTyping(ctx context.Context, msg *bridgev2.MatrixTyping) error {
	if c.bb == nil || !c.privateAPI.Load() {
		return nil
	}
	chat, err := c.chatGUID(ctx, msg.Portal)
	if err != nil || chat == "" {
		return err
	}
	return c.bb.Typing(ctx, chat, msg.IsTyping)
}

// Messages' limits on changing a sent message.
var (
	editMaxAge   = jsontime.S(15 * time.Minute)
	deleteMaxAge = jsontime.S(2 * time.Minute)
)

// GetCapabilities is what a chat can do. Everything sent needs the Private API on the Mac;
// without it the Mac only receives, and the chat offers nothing to send.
func (c *Client) GetCapabilities(ctx context.Context, portal *bridgev2.Portal) *event.RoomFeatures {
	if c.privateAPI.Load() {
		return fullFeatures
	}
	return receiveOnly
}

func fileFeatures(caption event.CapabilitySupportLevel) event.FileFeatureMap {
	any := map[string]event.CapabilitySupportLevel{"*/*": event.CapLevelFullySupported}
	feature := func() *event.FileFeatures {
		return &event.FileFeatures{MimeTypes: any, Caption: caption, MaxSize: maxFileBytes}
	}
	return event.FileFeatureMap{
		event.MsgImage: feature(), event.MsgVideo: feature(), event.MsgAudio: feature(), event.MsgFile: feature(),
		event.CapMsgGIF: feature(), event.CapMsgVoice: feature(),
	}
}

var (
	receiveOnly = &event.RoomFeatures{
		ID:       "trioditis.imessage.capabilities.2026_11_24.receive_only",
		File:     event.FileFeatureMap{},
		Reply:    event.CapLevelRejected,
		Edit:     event.CapLevelRejected,
		Delete:   event.CapLevelRejected,
		Reaction: event.CapLevelRejected,
	}
	fullFeatures = &event.RoomFeatures{
		ID:                  "trioditis.imessage.capabilities.2026_11_24.private_api",
		File:                fileFeatures(event.CapLevelFullySupported),
		MaxTextLength:       20000,
		Reply:               event.CapLevelFullySupported,
		Edit:                event.CapLevelFullySupported,
		EditMaxCount:        5,
		EditMaxAge:          &editMaxAge,
		Delete:              event.CapLevelFullySupported,
		DeleteMaxAge:        &deleteMaxAge,
		Reaction:            event.CapLevelFullySupported,
		ReactionCount:       1,
		AllowedReactions:    []string{"❤️", "👍", "👎", "😂", "‼️", "❓"},
		ReadReceipts:        true,
		TypingNotifications: true,
	}
)

package imessage

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// MessageMetadata is what is kept with each bridged message: when it was last edited (Unix
// ms), so an edit reported again with the message's later changes isn't applied twice.
type MessageMetadata struct {
	EditedAt int64 `json:"edited_at,omitempty"`
}

// handleEvent hands one socket event to bridgev2. Only an event's kind is ever logged. It
// returns the time of a new message bridgev2 couldn't take, so it can be fetched again, or 0.
func (c *Client) handleEvent(ctx context.Context, evt bluebubbles.Event) (failedAt int64) {
	log := zerolog.Ctx(ctx)
	switch evt.Name {
	case "new-message", "updated-message":
		var msg bluebubbles.Message
		if err := json.Unmarshal(evt.Data, &msg); err != nil {
			log.Warn().Str("event", evt.Name).Msg("Couldn't read an event from BlueBubbles Server")
			return 0
		}
		if evt.Name == "new-message" {
			if !c.handleNewMessage(&msg) {
				return max(msg.DateCreated, 1)
			}
		} else {
			c.handleUpdatedMessage(&msg)
		}
	case "typing-indicator":
		var typing bluebubbles.TypingIndicator
		if json.Unmarshal(evt.Data, &typing) == nil {
			c.handleTyping(&typing)
		}
	case "chat-read-status-changed":
		var read bluebubbles.ChatReadStatus
		if json.Unmarshal(evt.Data, &read) == nil && read.Read {
			c.handleReadElsewhere(ctx, read.ChatGUID)
		}
	case "group-name-change", "participant-added", "participant-removed", "participant-left",
		"group-icon-changed", "group-icon-removed":
		var msg bluebubbles.Message
		if json.Unmarshal(evt.Data, &msg) == nil && msg.ChatGUID() != "" {
			c.queueResync(ctx, msg.ChatGUID(), time.Time{}, false)
		}
	case "message-send-error":
		// A message Messages took and then failed to send. A send from Trioditis has its
		// outcome already: Messages reports most failures before the server answers, and
		// one it reports later is in Messages, marked failed, for the person to see there.
		log.Warn().Msg("Messages reported a message failed to send after taking it")
	}
	return 0
}

// handleNewMessage bridges a new message or tapback, and says whether bridgev2 took it (or
// had it already). Chat changes (renames, members) come as their own events; a message
// Messages marked failed isn't one anyone received, and one already unsent is gone.
func (c *Client) handleNewMessage(msg *bluebubbles.Message) bool {
	chatGUID := msg.ChatGUID()
	if chatGUID == "" || msg.GUID == "" || msg.ItemType != 0 || msg.Unsent() || msg.IsFromMe && msg.Error != 0 {
		return true
	}
	if kind := msg.TapbackType(); kind != "" {
		c.handleTapback(chatGUID, msg, kind)
		return true
	}
	at := time.UnixMilli(msg.DateCreated)
	res := c.login.QueueRemoteEvent(&simplevent.Message[*bluebubbles.Message]{
		EventMeta: simplevent.EventMeta{
			Type:         bridgev2.RemoteEventMessage,
			PortalKey:    c.portalKey(chatGUID),
			Sender:       c.messageSender(chatGUID, msg),
			CreatePortal: true,
			Timestamp:    at,
			StreamOrder:  msg.DateCreated,
		},
		ID:                 networkid.MessageID(msg.GUID),
		Data:               msg,
		ConvertMessageFunc: c.convertMessage,
	})
	return res.Success || res.Ignored
}

// handleUpdatedMessage bridges what changed about a message: unsent, edited, or, for the
// person's own message in a direct chat, read by the other person.
func (c *Client) handleUpdatedMessage(msg *bluebubbles.Message) {
	chatGUID := msg.ChatGUID()
	if chatGUID == "" || msg.GUID == "" || msg.ItemType != 0 || msg.TapbackType() != "" {
		return
	}
	key := c.portalKey(chatGUID)
	sender := c.messageSender(chatGUID, msg)
	switch {
	case msg.Unsent():
		at := msg.DateRetracted
		if at == 0 {
			at = msg.DateEdited
		}
		c.login.QueueRemoteEvent(&simplevent.MessageRemove{
			EventMeta: simplevent.EventMeta{
				Type: bridgev2.RemoteEventMessageRemove, PortalKey: key, Sender: sender,
				Timestamp: time.UnixMilli(at),
			},
			TargetMessage: networkid.MessageID(msg.GUID),
		})
	case msg.DateEdited != 0:
		c.login.QueueRemoteEvent(&simplevent.Message[*bluebubbles.Message]{
			EventMeta: simplevent.EventMeta{
				Type: bridgev2.RemoteEventEdit, PortalKey: key, Sender: sender,
				Timestamp: time.UnixMilli(msg.DateEdited),
			},
			TargetMessage:   networkid.MessageID(msg.GUID),
			Data:            msg,
			ConvertEditFunc: c.convertEdit,
		})
	}
	address := dmAddress(key.ID)
	if msg.IsFromMe && msg.DateRead != 0 && address != "" {
		if last, ok := c.lastRead.Load(key.ID); ok && last.(string) == msg.GUID {
			return
		}
		c.lastRead.Store(key.ID, msg.GUID)
		c.login.QueueRemoteEvent(&simplevent.Receipt{
			EventMeta: simplevent.EventMeta{
				Type: bridgev2.RemoteEventReadReceipt, PortalKey: key, Sender: c.sender(false, address),
				Timestamp: time.UnixMilli(msg.DateRead),
			},
			LastTarget: networkid.MessageID(msg.GUID),
			ReadUpTo:   time.UnixMilli(msg.DateRead),
		})
	}
}

// messageSender is who sent a message: the person, or the handle it came from (in a direct
// chat, the chat's other person if the server left the handle out).
func (c *Client) messageSender(chatGUID string, msg *bluebubbles.Message) bridgev2.EventSender {
	if msg.IsFromMe {
		return c.sender(true, "")
	}
	if msg.Handle != nil && msg.Handle.Address != "" {
		return c.sender(false, msg.Handle.Address)
	}
	return c.sender(false, dmAddress(chatID(chatGUID)))
}

// The classic tapbacks, as emoji. Messages shows others only by their emoji ("emoji").
var tapbackEmoji = map[string]string{
	"love": "❤️", "like": "👍", "dislike": "👎", "laugh": "😂", "emphasize": "‼️", "question": "❓",
}

func (c *Client) handleTapback(chatGUID string, msg *bluebubbles.Message, kind string) {
	remove := strings.HasPrefix(kind, "-")
	name := strings.TrimPrefix(kind, "-")
	emoji := tapbackEmoji[name]
	if name == "emoji" {
		emoji = reactedEmoji(msg.Text)
	}
	if emoji == "" && !remove {
		// A sticker on a message, or an emoji the server didn't say.
		return
	}
	meta := simplevent.EventMeta{
		Type:      bridgev2.RemoteEventReaction,
		PortalKey: c.portalKey(chatGUID),
		Sender:    c.messageSender(chatGUID, msg),
		Timestamp: time.UnixMilli(msg.DateCreated),
	}
	if remove {
		meta.Type = bridgev2.RemoteEventReactionRemove
	}
	// One tapback per person per message: a new one replaces theirs (no emoji ID).
	c.login.QueueRemoteEvent(&simplevent.Reaction{
		EventMeta:     meta,
		TargetMessage: networkid.MessageID(targetGUID(msg.AssociatedMessageGUID)),
		Emoji:         emoji,
	})
}

// reactedEmoji is the emoji in an emoji tapback's text, which Messages writes as
// "Reacted 🎉 to “…”". The server doesn't give the emoji itself.
func reactedEmoji(text string) string {
	rest, ok := strings.CutPrefix(text, "Reacted ")
	if !ok {
		return ""
	}
	emoji, _, ok := strings.Cut(rest, " ")
	if !ok || emoji == "" || len(emoji) > 32 {
		return ""
	}
	for _, r := range emoji {
		if r < 0x80 {
			return ""
		}
	}
	return emoji
}

func (c *Client) handleTyping(typing *bluebubbles.TypingIndicator) {
	address := dmAddress(chatID(typing.GUID))
	if address == "" {
		return
	}
	var timeout time.Duration
	if typing.Display {
		timeout = typingTimeout
	}
	c.login.QueueRemoteEvent(&simplevent.Typing{
		EventMeta: simplevent.EventMeta{
			Type: bridgev2.RemoteEventTyping, PortalKey: c.portalKey(typing.GUID), Sender: c.sender(false, address),
		},
		Timeout: timeout,
	})
}

// typingTimeout is how long someone shows as typing without word that they stopped.
const typingTimeout = 2 * time.Minute

// handleReadElsewhere is the person having read a chat on the Mac, or on another of their
// Apple devices: it is read up to its last message.
func (c *Client) handleReadElsewhere(ctx context.Context, chatGUID string) {
	key := c.portalKey(chatGUID)
	last, err := c.conn.bridge.DB.Message.GetLastNonFakePartAtOrBeforeTime(ctx, key, time.Now().Add(time.Minute))
	if err != nil || last == nil {
		return
	}
	c.login.QueueRemoteEvent(&simplevent.Receipt{
		EventMeta: simplevent.EventMeta{
			Type: bridgev2.RemoteEventReadReceipt, PortalKey: key, Sender: c.sender(true, ""),
		},
		LastTarget: last.ID,
	})
}

// convertMessage turns a message into its parts: each file, then its text.
func (c *Client) convertMessage(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, msg *bluebubbles.Message) (*bridgev2.ConvertedMessage, error) {
	converted := &bridgev2.ConvertedMessage{}
	meta := &MessageMetadata{EditedAt: msg.DateEdited}
	for i := range msg.Attachments {
		att := &msg.Attachments[i]
		if att.HideAttachment {
			continue
		}
		part := c.convertAttachment(ctx, portal, intent, att, len(converted.Parts))
		part.DBMetadata = meta
		converted.Parts = append(converted.Parts, part)
	}
	if text := messageText(msg); text != "" {
		converted.Parts = append(converted.Parts, &bridgev2.ConvertedMessagePart{
			ID:         textPart,
			Type:       eventMessage,
			Content:    textContent(text),
			DBMetadata: meta,
		})
	}
	if len(converted.Parts) == 0 {
		// A message only an app on an iPhone can show (a game, a payment, a sticker alone).
		converted.Parts = append(converted.Parts, &bridgev2.ConvertedMessagePart{
			ID:         textPart,
			Type:       eventMessage,
			Content:    noticeContent("This message can only be seen in Messages on an Apple device."),
			DBMetadata: meta,
		})
	}
	if msg.ThreadOriginatorGUID != "" {
		converted.ReplyTo = &networkid.MessageOptionalPartID{MessageID: networkid.MessageID(msg.ThreadOriginatorGUID)}
	}
	return converted, nil
}

// textPart is the ID of a message's text part; a file is "a<n>".
const textPart networkid.PartID = "text"

// messageText is what a message says: its subject, if it has one, above its text.
func messageText(msg *bluebubbles.Message) string {
	text := strings.ReplaceAll(msg.Text, "￼", "")
	text = strings.TrimSpace(text)
	if subject := strings.TrimSpace(msg.Subject); subject != "" {
		if text == "" {
			return subject
		}
		return subject + "\n" + text
	}
	return text
}

// convertEdit is a message's new text. An edit already applied (reported again with a later
// change) is ignored, as is one to a message with no text part.
func (c *Client) convertEdit(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, existing []*database.Message, msg *bluebubbles.Message) (*bridgev2.ConvertedEdit, error) {
	var target *database.Message
	for _, part := range existing {
		if part.PartID == textPart {
			target = part
		}
	}
	if target == nil {
		return nil, bridgev2.ErrIgnoringRemoteEvent
	}
	meta, _ := target.Metadata.(*MessageMetadata)
	if meta != nil && meta.EditedAt >= msg.DateEdited {
		return nil, bridgev2.ErrIgnoringRemoteEvent
	}
	text := messageText(msg)
	if text == "" {
		return nil, bridgev2.ErrIgnoringRemoteEvent
	}
	target.Metadata = &MessageMetadata{EditedAt: msg.DateEdited}
	return &bridgev2.ConvertedEdit{
		ModifiedParts: []*bridgev2.ConvertedEditPart{{
			Part:    target,
			Type:    eventMessage,
			Content: textContent(text),
		}},
	}, nil
}

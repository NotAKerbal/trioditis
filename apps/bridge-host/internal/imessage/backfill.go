package imessage

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// maxFetch is the most messages the server lists at once.
const maxFetch = 1000

// FetchMessages lists a chat's messages for bridgev2's backfill: newer than the newest it
// has (forward, catching up), or older than the oldest (backward, history).
func (c *Client) FetchMessages(ctx context.Context, params bridgev2.FetchMessagesParams) (*bridgev2.FetchMessagesResponse, error) {
	if c.bb == nil {
		return nil, bridgev2.ErrNotLoggedIn
	}
	limit := min(max(params.Count, 1), maxFetch)
	// Newest first, either way: catching up brings in the latest messages (as many as asked
	// for), and history goes back from the oldest the chat has.
	q := bluebubbles.MessageQuery{Limit: limit}
	if params.Forward {
		if params.AnchorMessage != nil {
			q.After = params.AnchorMessage.Timestamp.UnixMilli()
		}
	} else if params.Cursor != "" {
		q.Before, _ = strconv.ParseInt(string(params.Cursor), 10, 64)
	} else if params.AnchorMessage != nil {
		q.Before = params.AnchorMessage.Timestamp.UnixMilli()
	}
	raw, err := c.bb.ChatMessages(ctx, string(params.Portal.ID), q)
	if err != nil {
		return nil, err
	}
	slices.Reverse(raw)
	resp := &bridgev2.FetchMessagesResponse{Forward: params.Forward, HasMore: len(raw) == limit}
	if len(raw) > 0 && !params.Forward {
		// The server's bounds include their own time; the next page starts just before.
		resp.Cursor = networkid.PaginationCursor(strconv.FormatInt(raw[0].DateCreated-1, 10))
	}
	byID := map[networkid.MessageID]*bridgev2.BackfillMessage{}
	var tapbacks []*bluebubbles.Message
	for i := range raw {
		msg := &raw[i]
		if params.AnchorMessage != nil && networkid.MessageID(msg.GUID) == params.AnchorMessage.ID {
			continue
		}
		if msg.GUID == "" || msg.ItemType != 0 || msg.Unsent() || msg.IsFromMe && msg.Error != 0 {
			continue
		}
		if msg.TapbackType() != "" {
			tapbacks = append(tapbacks, msg)
			continue
		}
		converted, err := c.convertMessage(ctx, params.Portal, c.conn.bridge.Bot, msg)
		if err != nil {
			return nil, err
		}
		at := time.UnixMilli(msg.DateCreated)
		bm := &bridgev2.BackfillMessage{
			ConvertedMessage: converted,
			Sender:           c.messageSender(string(params.Portal.ID), msg),
			ID:               networkid.MessageID(msg.GUID),
			Timestamp:        at,
			StreamOrder:      msg.DateCreated,
		}
		byID[bm.ID] = bm
		resp.Messages = append(resp.Messages, bm)
	}
	c.backfillTapbacks(params, byID, tapbacks)
	return resp, nil
}

// backfillTapbacks puts each person's last tapback on the message it is on, where that message
// is in the batch. Going forward (catching up), one on an earlier message is handed over as
// it happened, once the batch is in; going back, one on a message older than the batch comes
// with that message's own batch only if it is in it, so it is left.
func (c *Client) backfillTapbacks(params bridgev2.FetchMessagesParams, byID map[networkid.MessageID]*bridgev2.BackfillMessage, tapbacks []*bluebubbles.Message) {
	type key struct {
		target networkid.MessageID
		sender networkid.UserID
	}
	latest := map[key]*bluebubbles.Message{}
	var order []key
	for _, t := range tapbacks {
		sender := c.messageSender(string(params.Portal.ID), t)
		k := key{networkid.MessageID(targetGUID(t.AssociatedMessageGUID)), sender.Sender}
		if _, ok := latest[k]; !ok {
			order = append(order, k)
		}
		latest[k] = t
	}
	for _, k := range order {
		t := latest[k]
		kind := t.TapbackType()
		if bm := byID[k.target]; bm != nil {
			name := strings.TrimPrefix(kind, "-")
			emoji := tapbackEmoji[name]
			if name == "emoji" {
				emoji = reactedEmoji(t.Text)
			}
			if strings.HasPrefix(kind, "-") || emoji == "" {
				continue
			}
			bm.Reactions = append(bm.Reactions, &bridgev2.BackfillReaction{
				Timestamp: time.UnixMilli(t.DateCreated),
				Sender:    c.messageSender(string(params.Portal.ID), t),
				Emoji:     emoji,
			})
		} else if params.Forward {
			// After the batch: bridgev2 holds the chat while it backfills.
			go c.handleTapback(string(params.Portal.ID), t, kind)
		}
	}
}

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// ResolveIdentifier finds the direct chat with a phone number (in international form) or
// an email address. Messages makes the chat when its first message is sent, so nothing is
// asked of the Mac here: whether they use iMessage shows when that message goes.
func (c *Client) ResolveIdentifier(ctx context.Context, identifier string, createChat bool) (*bridgev2.ResolveIdentifierResponse, error) {
	address, ok := c.address(networkid.UserID(identifier))
	if !ok {
		address = normalAddress(identifier)
	}
	if !validAddress(address) {
		return nil, mautrix.MInvalidParam.WithMessage("not a phone number with its country code, or an email address")
	}
	userID := c.userID(address)
	ghost, err := c.conn.bridge.GetGhostByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	resp := &bridgev2.ResolveIdentifierResponse{Ghost: ghost, UserID: userID}
	if createChat {
		resp.Chat = &bridgev2.CreateChatResponse{
			PortalKey:  c.portalKey("any;-;" + address),
			PortalInfo: c.dmInfo(address),
		}
	}
	return resp, nil
}

func validAddress(address string) bool {
	if strings.Contains(address, "@") {
		return emailPattern.MatchString(address) && len(address) <= 254
	}
	if !strings.HasPrefix(address, "+") || len(address) < 8 || len(address) > 16 {
		return false
	}
	for _, r := range address[1:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

package imessage

import (
	"cmp"
	"context"
	"errors"
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
	raw, more, err := c.chatHistory(ctx, params.Portal.ID, q)
	if err != nil {
		return nil, err
	}
	slices.Reverse(raw)
	resp := &bridgev2.FetchMessagesResponse{Forward: params.Forward, HasMore: more}
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

// backfillTapbacks puts each person's last tapback on the message it is on. Going back through
// history, a tapback can come a page before its message (it is newer): it is kept until the
// page with its message comes, and goes on that message then. Going forward (catching up), one
// on an earlier message is handed over as it happened, once the batch is in.
func (c *Client) backfillTapbacks(params bridgev2.FetchMessagesParams, byID map[networkid.MessageID]*bridgev2.BackfillMessage, tapbacks []*bluebubbles.Message) {
	type key struct {
		target networkid.MessageID
		sender networkid.UserID
	}
	portal := string(params.Portal.ID)
	latest := map[key]*bluebubbles.Message{}
	var order []key
	add := func(t *bluebubbles.Message) {
		k := key{networkid.MessageID(targetGUID(t.AssociatedMessageGUID)), c.messageSender(portal, t).Sender}
		if prev, ok := latest[k]; !ok {
			order = append(order, k)
		} else if prev.DateCreated > t.DateCreated {
			return
		}
		latest[k] = t
	}
	// Tapbacks kept from newer pages, on messages in this one.
	for id := range byID {
		for _, t := range c.takeKeptTapbacks(params.Portal.PortalKey, id) {
			add(t)
		}
	}
	for _, t := range tapbacks {
		add(t)
	}
	for _, k := range order {
		t := latest[k]
		kind := t.TapbackType()
		bm := byID[k.target]
		switch {
		case bm != nil:
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
				Sender:    c.messageSender(portal, t),
				Emoji:     emoji,
			})
		case params.Forward:
			// After the batch: bridgev2 holds the chat while it backfills.
			go c.handleTapback(portal, t, kind)
		default:
			c.keepTapback(params.Portal.PortalKey, k.target, t)
		}
	}
}

// maxKeptTapbacks bounds the tapbacks kept for messages further back in history. They are kept
// in memory: a restart in the middle of a chat's history loses them, and the messages they
// were on come in without them.
const maxKeptTapbacks = 10000

type keptKey struct {
	portal networkid.PortalKey
	target networkid.MessageID
}

func (c *Client) keepTapback(portal networkid.PortalKey, target networkid.MessageID, t *bluebubbles.Message) {
	c.keptLock.Lock()
	defer c.keptLock.Unlock()
	if c.kept == nil {
		c.kept = map[keptKey][]*bluebubbles.Message{}
	}
	if c.keptCount >= maxKeptTapbacks {
		return
	}
	k := keptKey{portal, target}
	c.kept[k] = append(c.kept[k], t)
	c.keptCount++
}

func (c *Client) takeKeptTapbacks(portal networkid.PortalKey, target networkid.MessageID) []*bluebubbles.Message {
	c.keptLock.Lock()
	defer c.keptLock.Unlock()
	k := keptKey{portal, target}
	kept := c.kept[k]
	delete(c.kept, k)
	c.keptCount -= len(kept)
	return kept
}

// serviceChats are the chats Messages may keep for one portal. Before macOS 26, someone's
// iMessage, SMS and RCS conversations are separate chats, which the portal's "any" ID brings
// together; the server finds only one of them by that ID, so each is asked for by its own.
func serviceChats(id networkid.PortalID) []string {
	rest, ok := strings.CutPrefix(string(id), "any;")
	if !ok {
		return []string{string(id)}
	}
	return []string{"iMessage;" + rest, "SMS;" + rest, "RCS;" + rest}
}

// chatHistory is a portal's messages within q, newest first, from every chat Messages keeps
// for it, each message once (on macOS 26 every name finds the same chat), and whether there
// are more beyond them.
func (c *Client) chatHistory(ctx context.Context, id networkid.PortalID, q bluebubbles.MessageQuery) ([]bluebubbles.Message, bool, error) {
	seen := map[string]bool{}
	var all []bluebubbles.Message
	more := false
	for _, guid := range serviceChats(id) {
		page, err := c.bb.ChatMessages(ctx, guid, q)
		var bbErr *bluebubbles.Error
		if errors.As(err, &bbErr) && bbErr.NotFound() {
			continue
		} else if err != nil {
			return nil, false, err
		}
		more = more || len(page) == q.Limit
		for _, m := range page {
			if m.GUID != "" && !seen[m.GUID] {
				seen[m.GUID] = true
				all = append(all, m)
			}
		}
	}
	slices.SortStableFunc(all, func(a, b bluebubbles.Message) int {
		if a.DateCreated != b.DateCreated {
			return cmp.Compare(b.DateCreated, a.DateCreated)
		}
		return cmp.Compare(a.GUID, b.GUID)
	})
	if len(all) > q.Limit {
		all, more = all[:q.Limit], true
	}
	return all, more, nil
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

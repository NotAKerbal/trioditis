// Package testconnector is a bridgev2 network connector for the bridge host's own tests. It
// is not a network: nothing registers it, and only tests import it, so it is never part of
// the bridge-host binary. It logs in with any username, takes incoming messages from Go
// calls, records what it is asked to send, and can be told to make sends fail or become
// ambiguous.
package testconnector

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"go.mau.fi/util/configupgrade"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// SendMode controls what happens to the next sends.
type SendMode int32

const (
	// SendOK accepts sends.
	SendOK SendMode = iota
	// SendAmbiguous fails without saying whether the network got the message, like a
	// connection dropping after the request went out.
	SendAmbiguous
	// SendRefused fails in a way the network is sure about.
	SendRefused
)

// Sent is a message the test connector was asked to send.
type Sent struct {
	LoginID networkid.UserLoginID
	ChatID  networkid.PortalID
	ID      networkid.MessageID
	Body    string
	Edit    bool
}

// HistoryMessage is a message the test connector returns from backfill.
type HistoryMessage struct {
	ID       networkid.MessageID
	SenderID networkid.UserID
	Text     string
	TS       time.Time
}

// Network is the test connector.
type Network struct {
	Bridge *bridgev2.Bridge

	mode          atomic.Int32
	incomingDelay atomic.Int64
	delay         atomic.Int64
	counter       atomic.Int64
	reactions     atomic.Int64
	maxReactions  atomic.Int32

	lock    sync.Mutex
	sent    []Sent
	history map[networkid.PortalID][]HistoryMessage
}

var (
	_ bridgev2.NetworkConnector = (*Network)(nil)
)

func New() *Network {
	return &Network{history: make(map[networkid.PortalID][]HistoryMessage)}
}

func (n *Network) SetSendMode(mode SendMode) { n.mode.Store(int32(mode)) }

// Sent returns everything sent so far.
func (n *Network) Sent() []Sent {
	n.lock.Lock()
	defer n.lock.Unlock()
	return slices.Clone(n.sent)
}

// SetHistory sets what backfill returns for a chat, oldest first.
func (n *Network) SetHistory(chatID networkid.PortalID, messages []HistoryMessage) {
	n.lock.Lock()
	defer n.lock.Unlock()
	n.history[chatID] = messages
}

func (n *Network) Init(br *bridgev2.Bridge)         { n.Bridge = br }
func (n *Network) Start(ctx context.Context) error  { return nil }
func (n *Network) GetBridgeInfoVersion() (int, int) { return 1, 1 }

func (n *Network) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{
		DisplayName: "Test network", NetworkURL: "https://example.invalid", NetworkID: "testnet", BeeperBridgeType: "testnet",
	}
}

func (n *Network) GetDBMetaTypes() database.MetaTypes { return database.MetaTypes{} }

func (n *Network) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}

func (n *Network) GetConfig() (string, any, configupgrade.Upgrader) { return "", nil, nil }

func (n *Network) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	login.Client = &Client{n: n, login: login}
	return nil
}

func (n *Network) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{{Name: "Username", Description: "Log in with any username", ID: "username"}}
}

func (n *Network) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	return &login{n: n, user: user}, nil
}

type login struct {
	n    *Network
	user *bridgev2.User
}

func (l *login) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type: bridgev2.LoginStepTypeUserInput, StepID: "testnet.username", Instructions: "Pick a username",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{
			Type: bridgev2.LoginInputFieldTypeUsername, ID: "username", Name: "Username",
		}}},
	}, nil
}

func (l *login) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	username := input["username"]
	if username == "" {
		return nil, errors.New("a username is required")
	}
	ul, err := l.user.NewLogin(ctx, &database.UserLogin{ID: networkid.UserLoginID(username), RemoteName: username}, &bridgev2.NewLoginParams{
		LoadUserLogin: l.n.LoadUserLogin,
	})
	if err != nil {
		return nil, err
	}
	go ul.Client.Connect(ul.Log.WithContext(context.Background()))
	return &bridgev2.LoginStep{
		Type: bridgev2.LoginStepTypeComplete, StepID: "testnet.complete", Instructions: "Logged in",
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: ul.ID, UserLogin: ul},
	}, nil
}

func (l *login) Cancel() {}

// Client is one login's connection to the test connector.
type Client struct {
	n     *Network
	login *bridgev2.UserLogin
}

var (
	_ bridgev2.NetworkAPI                    = (*Client)(nil)
	_ bridgev2.EditHandlingNetworkAPI        = (*Client)(nil)
	_ bridgev2.ReactionHandlingNetworkAPI    = (*Client)(nil)
	_ bridgev2.RedactionHandlingNetworkAPI   = (*Client)(nil)
	_ bridgev2.ReadReceiptHandlingNetworkAPI = (*Client)(nil)
	_ bridgev2.TypingHandlingNetworkAPI      = (*Client)(nil)
	_ bridgev2.BackfillingNetworkAPI         = (*Client)(nil)
	_ bridgev2.IdentifierResolvingNetworkAPI = (*Client)(nil)
)

// ResolveIdentifier finds a user by ID, or by "testnet:<id>". "nobody" is no one, so a
// test can see a not-found answer. The direct chat with a user is "dm-<id>".
func (c *Client) ResolveIdentifier(ctx context.Context, identifier string, createChat bool) (*bridgev2.ResolveIdentifierResponse, error) {
	user := networkid.UserID(strings.TrimPrefix(identifier, "testnet:"))
	if user == "" || user == "nobody" {
		return nil, nil
	}
	resp := &bridgev2.ResolveIdentifierResponse{UserID: user}
	if createChat {
		resp.Chat = &bridgev2.CreateChatResponse{PortalKey: networkid.PortalKey{ID: networkid.PortalID("dm-" + string(user)), Receiver: c.login.ID}}
	}
	return resp, nil
}

func (c *Client) Connect(ctx context.Context) {
	c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
}

func (c *Client) Disconnect()                      {}
func (c *Client) IsLoggedIn() bool                 { return true }
func (c *Client) LogoutRemote(ctx context.Context) {}
func (c *Client) self() networkid.UserID           { return networkid.UserID(c.login.ID) }
func (c *Client) IsThisUser(_ context.Context, userID networkid.UserID) bool {
	return userID == c.self()
}

// GetChatInfo describes a chat from its ID. A chat whose ID is "dm-<user>" is a direct chat
// with that user, named after them; any other ID is a group with one other member.
func (c *Client) GetChatInfo(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	other := networkid.UserID("peer-" + string(portal.ID))
	name := "Chat " + string(portal.ID)
	roomType := database.RoomTypeDefault
	if peer, ok := strings.CutPrefix(string(portal.ID), "dm-"); ok && peer != "" {
		other = networkid.UserID(peer)
		name = DisplayName(other)
		roomType = database.RoomTypeDM
	}
	// A chat whose ID starts "request-" is a message request, until AcceptRequest.
	request := strings.HasPrefix(string(portal.ID), "request-")
	return &bridgev2.ChatInfo{
		Name:           &name,
		Type:           &roomType,
		MessageRequest: &request,
		Members: &bridgev2.ChatMemberList{IsFull: true, OtherUserID: other, Members: []bridgev2.ChatMember{
			{EventSender: bridgev2.EventSender{IsFromMe: true, Sender: c.self()}, Membership: event.MembershipJoin},
			{EventSender: bridgev2.EventSender{Sender: other}, Membership: event.MembershipJoin},
		}},
		CanBackfill: true,
	}, nil
}

// DisplayName is the name the test connector gives a user: their ID with a capital letter, so
// "alice" is Alice.
func DisplayName(userID networkid.UserID) string {
	first, size := utf8.DecodeRuneInString(string(userID))
	if first == utf8.RuneError {
		return string(userID)
	}
	return string(unicode.ToUpper(first)) + string(userID)[size:]
}

func (c *Client) GetUserInfo(ctx context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	name := DisplayName(ghost.ID)
	return &bridgev2.UserInfo{Name: &name, Identifiers: []string{"testnet:" + string(ghost.ID)}}, nil
}

func (c *Client) GetCapabilities(ctx context.Context, portal *bridgev2.Portal) *event.RoomFeatures {
	full := event.CapLevelFullySupported
	return &event.RoomFeatures{
		ID:                  "testnet.v1",
		Reply:               full,
		Edit:                full,
		Delete:              full,
		Reaction:            full,
		ReadReceipts:        true,
		TypingNotifications: true,
		File: event.FileFeatureMap{
			event.MsgImage: {MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": full}, Caption: full},
			event.MsgFile:  {MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": full}, Caption: full},
		},
	}
}

// SetIncomingDelay makes handling each incoming message take this long, inside bridgev2's
// handling of the chat, as a connector downloading a large file does.
func (n *Network) SetIncomingDelay(d time.Duration) { n.incomingDelay.Store(int64(d)) }

// SetSendDelay makes each send (and reaction) wait this long before the network answers,
// holding the chat's queue like a slow network does. A delay ends early, with an error, if the bridge
// stops.
func (n *Network) SetSendDelay(d time.Duration) { n.delay.Store(int64(d)) }

// wait holds a send, reaction or removal for the send delay.
func (c *Client) wait(ctx context.Context) error {
	if d := time.Duration(c.n.delay.Load()); d > 0 {
		timer := time.NewTimer(d)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
	}
	return nil
}

func (c *Client) sendResult(ctx context.Context) error {
	if err := c.wait(ctx); err != nil {
		return err
	}
	switch SendMode(c.n.mode.Load()) {
	case SendAmbiguous:
		return errors.New("test connector: connection dropped after the request went out")
	case SendRefused:
		ms := bridgev2.WrapErrorInStatus(errors.New("test connector: message refused")).WithIsCertain(true)
		ms.Status = event.MessageStatusFail
		return ms
	default:
		return nil
	}
}

func (c *Client) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	if err := c.sendResult(ctx); err != nil {
		return nil, err
	}
	if msg.Content.URL != "" {
		// Read the attachment through the Matrix connector, as a real network would to
		// upload it.
		if _, err := c.n.Bridge.Bot.DownloadMedia(ctx, msg.Content.URL, msg.Content.File); err != nil {
			return nil, fmt.Errorf("test connector: can't read attachment: %w", err)
		}
	}
	msgID := networkid.MessageID(fmt.Sprintf("sent-%d", c.n.counter.Add(1)))
	c.n.lock.Lock()
	c.n.sent = append(c.n.sent, Sent{LoginID: c.login.ID, ChatID: msg.Portal.ID, ID: msgID, Body: msg.Content.Body})
	c.n.lock.Unlock()
	return &bridgev2.MatrixMessageResponse{DB: &database.Message{ID: msgID, SenderID: c.self(), Timestamp: time.Now()}}, nil
}

func (c *Client) HandleMatrixEdit(ctx context.Context, msg *bridgev2.MatrixEdit) error {
	if err := c.sendResult(ctx); err != nil {
		return err
	}
	c.n.lock.Lock()
	c.n.sent = append(c.n.sent, Sent{LoginID: c.login.ID, ChatID: msg.Portal.ID, ID: msg.EditTarget.ID, Body: msg.Content.Body, Edit: true})
	c.n.lock.Unlock()
	return nil
}

func (c *Client) PreHandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (bridgev2.MatrixReactionPreResponse, error) {
	key := msg.Content.RelatesTo.Key
	max := int(c.n.maxReactions.Load())
	emojiID := networkid.EmojiID(key)
	if max == 1 {
		emojiID = ""
	}
	return bridgev2.MatrixReactionPreResponse{SenderID: c.self(), EmojiID: emojiID, Emoji: key, MaxReactions: max}, nil
}

func (c *Client) HandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (*database.Reaction, error) {
	if err := c.wait(ctx); err != nil {
		return nil, err
	}
	c.n.reactions.Add(1)
	return &database.Reaction{}, nil
}

// SetMaxReactions limits how many reactions a person can have on one message: bridgev2 then
// takes away the oldest when a new one is added. 0 is no limit. At 1 the person has one
// reaction slot per message, with no emoji ID, as on WhatsApp and Signal, so bridgev2
// overwrites the old reaction's record with the new one before taking the old one away.
func (n *Network) SetMaxReactions(max int) { n.maxReactions.Store(int32(max)) }

// Reactions is how many reactions the test connector has taken.
func (n *Network) Reactions() int64 { return n.reactions.Load() }

func (c *Client) HandleMatrixReactionRemove(ctx context.Context, msg *bridgev2.MatrixReactionRemove) error {
	return nil
}

func (c *Client) HandleMatrixMessageRemove(ctx context.Context, msg *bridgev2.MatrixMessageRemove) error {
	return nil
}

func (c *Client) HandleMatrixReadReceipt(ctx context.Context, msg *bridgev2.MatrixReadReceipt) error {
	return nil
}

func (c *Client) HandleMatrixTyping(ctx context.Context, msg *bridgev2.MatrixTyping) error {
	return nil
}

func (c *Client) FetchMessages(ctx context.Context, params bridgev2.FetchMessagesParams) (*bridgev2.FetchMessagesResponse, error) {
	c.n.lock.Lock()
	history := slices.Clone(c.n.history[params.Portal.ID])
	c.n.lock.Unlock()
	// Backward pages end before the anchor (the oldest message already bridged); a forward
	// fetch returns everything after it.
	var page []HistoryMessage
	if params.Forward {
		for _, msg := range history {
			if params.AnchorMessage == nil || msg.TS.After(params.AnchorMessage.Timestamp) {
				page = append(page, msg)
			}
		}
	} else {
		var before []HistoryMessage
		for _, msg := range history {
			if params.AnchorMessage == nil || msg.TS.Before(params.AnchorMessage.Timestamp) {
				before = append(before, msg)
			}
		}
		start := max(len(before)-params.Count, 0)
		page = before[start:]
	}
	resp := &bridgev2.FetchMessagesResponse{Forward: params.Forward, HasMore: !params.Forward && len(page) > 0 && page[0].ID != firstID(history)}
	for _, msg := range page {
		resp.Messages = append(resp.Messages, &bridgev2.BackfillMessage{
			ConvertedMessage: textMessage(msg.Text),
			Sender:           c.sender(msg.SenderID),
			ID:               msg.ID,
			Timestamp:        msg.TS,
			StreamOrder:      msg.TS.UnixMilli(),
		})
	}
	return resp, nil
}

func firstID(history []HistoryMessage) networkid.MessageID {
	if len(history) == 0 {
		return ""
	}
	return history[0].ID
}

func (c *Client) sender(id networkid.UserID) bridgev2.EventSender {
	return bridgev2.EventSender{Sender: id, IsFromMe: id == c.self()}
}

func textMessage(text string) *bridgev2.ConvertedMessage {
	return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
		ID: "", Type: event.EventMessage, Content: &event.MessageEventContent{MsgType: event.MsgText, Body: text},
	}}}
}

func (n *Network) login(loginID networkid.UserLoginID) (*bridgev2.UserLogin, error) {
	ul := n.Bridge.GetCachedUserLoginByID(loginID)
	if ul == nil {
		return nil, fmt.Errorf("test connector: no login %s", loginID)
	}
	return ul, nil
}

func meta(evtType bridgev2.RemoteEventType, ul *bridgev2.UserLogin, chatID networkid.PortalID, senderID networkid.UserID, ts time.Time) simplevent.EventMeta {
	if ts.IsZero() {
		ts = time.Now()
	}
	return simplevent.EventMeta{
		Type:         evtType,
		PortalKey:    networkid.PortalKey{ID: chatID, Receiver: ul.ID},
		Sender:       bridgev2.EventSender{Sender: senderID, IsFromMe: senderID == networkid.UserID(ul.ID)},
		CreatePortal: true,
		Timestamp:    ts,
		StreamOrder:  ts.UnixMilli(),
	}
}

// Incoming delivers a text message from senderID in chatID to a login. A sender equal to
// the login ID is the person themselves, as when they message from their phone.
func (n *Network) Incoming(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, msgID networkid.MessageID, text string, ts time.Time) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta: meta(bridgev2.RemoteEventMessage, ul, chatID, senderID, ts),
		Data:      text,
		ID:        msgID,
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data string) (*bridgev2.ConvertedMessage, error) {
			if d := time.Duration(n.incomingDelay.Load()); d > 0 {
				time.Sleep(d)
			}
			return textMessage(data), nil
		},
	})
	return resultError(res)
}

// IncomingParts delivers a message in several parts (as a caption and its pictures arrive),
// one text part per entry, with part IDs p0, p1, …. It returns the remote event bridgev2 was
// given, so a test can follow its handling.
func (n *Network) IncomingParts(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, msgID networkid.MessageID, texts []string) (bridgev2.RemoteEvent, error) {
	ul, err := n.login(loginID)
	if err != nil {
		return nil, err
	}
	evt := &simplevent.Message[[]string]{
		EventMeta: meta(bridgev2.RemoteEventMessage, ul, chatID, senderID, time.Time{}),
		Data:      texts,
		ID:        msgID,
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data []string) (*bridgev2.ConvertedMessage, error) {
			converted := &bridgev2.ConvertedMessage{}
			for i, text := range data {
				converted.Parts = append(converted.Parts, &bridgev2.ConvertedMessagePart{
					ID: networkid.PartID(fmt.Sprintf("p%d", i)), Type: event.EventMessage,
					Content: &event.MessageEventContent{MsgType: event.MsgText, Body: text},
				})
			}
			return converted, nil
		},
	}
	return evt, resultError(ul.QueueRemoteEvent(evt))
}

// IncomingMention delivers a text message that mentions the person, written as connectors
// write a mention of the login itself: the person's Matrix ID.
func (n *Network) IncomingMention(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, msgID networkid.MessageID, text string) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta: meta(bridgev2.RemoteEventMessage, ul, chatID, senderID, time.Time{}),
		Data:      text,
		ID:        msgID,
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data string) (*bridgev2.ConvertedMessage, error) {
			converted := textMessage(data)
			converted.Parts[0].Content.Mentions = &event.Mentions{UserIDs: []id.UserID{ul.UserMXID}}
			return converted, nil
		},
	})
	return resultError(res)
}

// AcceptRequest says, as the network would, that the person accepted a message request.
func (n *Network) AcceptRequest(loginID networkid.UserLoginID, chatID networkid.PortalID) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	accepted := false
	evtMeta := meta(bridgev2.RemoteEventChatInfoChange, ul, chatID, networkid.UserID(ul.ID), time.Time{})
	evtMeta.CreatePortal = false
	res := ul.QueueRemoteEvent(&simplevent.ChatInfoChange{
		EventMeta:      evtMeta,
		ChatInfoChange: &bridgev2.ChatInfoChange{ChatInfo: &bridgev2.ChatInfo{MessageRequest: &accepted}},
	})
	return resultError(res)
}

// IncomingImage delivers an image, uploaded through the Matrix connector as a real network
// would.
func (n *Network) IncomingImage(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, msgID networkid.MessageID, data []byte, ts time.Time) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Message[[]byte]{
		EventMeta: meta(bridgev2.RemoteEventMessage, ul, chatID, senderID, ts),
		Data:      data,
		ID:        msgID,
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data []byte) (*bridgev2.ConvertedMessage, error) {
			uri, file, err := intent.UploadMedia(ctx, portal.MXID, data, "photo.png", "image/png")
			if err != nil {
				return nil, err
			}
			return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
				Type: event.EventMessage,
				Content: &event.MessageEventContent{
					MsgType: event.MsgImage, Body: "photo.png", URL: uri, File: file,
					Info: &event.FileInfo{MimeType: "image/png", Size: len(data)},
				},
			}}}, nil
		},
	})
	return resultError(res)
}

// Edit replaces a message's text.
func (n *Network) Edit(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, target networkid.MessageID, text string) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta:     meta(bridgev2.RemoteEventEdit, ul, chatID, senderID, time.Time{}),
		Data:          text,
		TargetMessage: target,
		ConvertEditFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, existing []*database.Message, data string) (*bridgev2.ConvertedEdit, error) {
			return &bridgev2.ConvertedEdit{ModifiedParts: []*bridgev2.ConvertedEditPart{{
				Part: existing[0], Type: event.EventMessage,
				Content: &event.MessageEventContent{MsgType: event.MsgText, Body: data},
			}}}, nil
		},
	})
	return resultError(res)
}

// React adds (or with remove, takes away) a reaction.
func (n *Network) React(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, target networkid.MessageID, emoji string, remove bool) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	evtType := bridgev2.RemoteEventReaction
	if remove {
		evtType = bridgev2.RemoteEventReactionRemove
	}
	res := ul.QueueRemoteEvent(&simplevent.Reaction{
		EventMeta: meta(evtType, ul, chatID, senderID, time.Time{}), TargetMessage: target,
		EmojiID: networkid.EmojiID(emoji), Emoji: emoji,
	})
	return resultError(res)
}

// Remove deletes a message for everyone.
func (n *Network) Remove(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, target networkid.MessageID) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.MessageRemove{
		EventMeta: meta(bridgev2.RemoteEventMessageRemove, ul, chatID, senderID, time.Time{}), TargetMessage: target,
	})
	return resultError(res)
}

// DeleteChat deletes a chat, as when the person deletes it on their phone.
func (n *Network) DeleteChat(loginID networkid.UserLoginID, chatID networkid.PortalID) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	evtMeta := meta(bridgev2.RemoteEventChatDelete, ul, chatID, networkid.UserID(ul.ID), time.Time{})
	evtMeta.CreatePortal = false
	res := ul.QueueRemoteEvent(&simplevent.ChatDelete{EventMeta: evtMeta, OnlyForMe: true})
	return resultError(res)
}

// Receipt marks messages up to target as read by senderID.
func (n *Network) Receipt(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, target networkid.MessageID) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Receipt{
		EventMeta: meta(bridgev2.RemoteEventReadReceipt, ul, chatID, senderID, time.Time{}), LastTarget: target,
	})
	return resultError(res)
}

// Typing shows senderID typing for timeout.
func (n *Network) Typing(loginID networkid.UserLoginID, chatID networkid.PortalID, senderID networkid.UserID, timeout time.Duration) error {
	ul, err := n.login(loginID)
	if err != nil {
		return err
	}
	res := ul.QueueRemoteEvent(&simplevent.Typing{
		EventMeta: meta(bridgev2.RemoteEventTyping, ul, chatID, senderID, time.Time{}), Timeout: timeout,
	})
	return resultError(res)
}

func resultError(res bridgev2.EventHandlingResult) error {
	if !res.Success {
		if res.Error != nil {
			return res.Error
		}
		return errors.New("test connector: event wasn't handled")
	}
	return nil
}

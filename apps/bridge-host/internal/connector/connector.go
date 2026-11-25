// Package connector is Trioditis's own bridgev2 MatrixConnector. bridgev2's network
// connectors (WhatsApp, Signal, …) talk to it as if it were a Matrix homeserver; it turns
// what they "send to Matrix" into sealed protocol events in the journal, and turns gateway
// commands into the Matrix-side events bridgev2 expects. No homeserver exists.
package connector

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"
	"go.mau.fi/util/exsync"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/keys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// Options are what the connector needs from the rest of the bridge host.
type Options struct {
	Network   string
	Store     *store.Store
	Keys      *keys.Keys
	Media     *media.Store
	Opaque    *ids.Opaquer
	BridgeKey seal.KeyPair
	// Notify is called after every journal append, to wake the event pusher.
	Notify func()
	// SendTimeout is how long a send may wait for an outcome before it is marked unknown.
	SendTimeout time.Duration
	// Signin, if set, runs cookie login steps in the sign-in browser.
	Signin *signin.Launcher
	// History, if set, holds back the backfill queue's next task while the server is behind on
	// this host's events (gateway.Pusher.WaitForRoom).
	History HistoryGate
	// DescribeSettle is how long DescribeDirectChats lets changes it may have raced settle
	// before checking them; five seconds if zero.
	DescribeSettle time.Duration
}

// HistoryGate waits, for a bounded time, until the server has room for more history, and says
// how long it waited.
type HistoryGate interface {
	WaitForRoom(ctx context.Context) time.Duration
}

// Connector implements bridgev2.MatrixConnector.
type Connector struct {
	Options
	Bridge *bridgev2.Bridge
	Log    zerolog.Logger

	bot     *Intent
	ghosts  *exsync.Map[networkid.UserID, *Intent]
	pending sync.Map // id.EventID → *pendingCommand
	logins  sync.Map // login session ID → *loginSession
	// endedLogins holds the IDs of logins this process ended (login session ID → struct{}).
	endedLogins sync.Map
	// messages serializes the attempts at one message, from handling to settling (messageLocks).
	messages messageLocks
	// browserSteps holds the login steps the sign-in browser submitted ("<login session
	// ID>/<step ID>" → struct{}), for as long as the process runs: a paste of one that arrives
	// later is dropped rather than refused.
	browserSteps sync.Map
	// busy holds chats (by opaque portal ID) with a command (a send, edit, reaction or
	// redaction) still out with bridgev2 or the network; the worker runs their next command
	// once it settles, or once the hold is released (see holdLimit).
	busy sync.Map // portal ID → id.EventID
	// lanes holds chats (by opaque portal ID) whose command is running on its own goroutine.
	lanes        sync.Map // portal ID → struct{}
	lanesRunning sync.WaitGroup
	// starting holds a lock per login (networkid.UserLoginID → *sync.Mutex), so one login's
	// startChat commands run one at a time.
	starting sync.Map
	// collageLocks holds a lock per room (id.RoomID → *sync.Mutex), so a chat's collage is
	// chosen, sent and recorded by one caller at a time, and the record is what was sent last.
	collageLocks sync.Map
	// pictures holds, for each ghost whose picture was set or removed in this process, whether
	// they have one now (networkid.UserID → bool): newer than the saved ghost until bridgev2
	// saves it, and never older after.
	pictures sync.Map
	wake     chan struct{}
	// repairs holds the contacts whose picture is to be fetched again (RunAvatarRepairs).
	repairs avatarRepairs
}

var (
	_ bridgev2.MatrixConnector                 = (*Connector)(nil)
	_ bridgev2.MatrixConnectorWithHTTPSettings = (*Connector)(nil)
)

// HTTPTransportWrapper is implemented by a network connector that needs to see the requests
// of the HTTP clients its library builds from the bridge's settings, which it can't reach
// otherwise (mautrix-gmessages' libgm keeps its clients private).
type HTTPTransportWrapper interface {
	WrapHTTPTransport(http.RoundTripper) http.RoundTripper
}

// GetHTTPClientSettings is what bridgev2 gives connectors to build HTTP clients from: its own
// default, with the network's transport wrapper (HTTPTransportWrapper) around the transport
// if it has one.
func (c *Connector) GetHTTPClientSettings() exhttp.ClientSettings {
	settings := exhttp.SensibleClientSettings
	if c.Bridge == nil {
		return settings
	}
	if wrapper, ok := c.Bridge.Network.(HTTPTransportWrapper); ok {
		settings.TransportOverride = func(cs exhttp.ClientSettings) http.RoundTripper {
			return wrapper.WrapHTTPTransport(cs.Configure(&http.Transport{}))
		}
	}
	return settings
}

// New makes a connector. Pass it to bridgev2.NewBridge, which calls Init.
func New(opts Options) *Connector {
	if opts.SendTimeout == 0 {
		opts.SendTimeout = 3 * time.Minute
	}
	if opts.Notify == nil {
		opts.Notify = func() {}
	}
	c := &Connector{Options: opts, ghosts: exsync.NewMap[networkid.UserID, *Intent](), wake: make(chan struct{}, 1)}
	c.bot = &Intent{c: c, mxid: ids.BotMXID, kind: intentBot}
	return c
}

func (c *Connector) Init(br *bridgev2.Bridge) {
	c.Bridge = br
	c.Log = br.Log.With().Str("component", "trioditis connector").Logger()
	// One connector per process: the patched bridgev2 tells it how each remote event's
	// handling really ended (third_party/mautrix.patch).
	bridgev2.RemoteEventDone = c.remoteEventDone
	bridgev2.RemoteEventStart = c.remoteEventStart
	// Older history waits while the server is behind, so the people using it aren't the ones
	// who lose. The queue waits before it takes a chat's backfill lock, which a chat's forward
	// catch-up also takes as its live events are handled, so live messages never wait on it.
	if c.History != nil {
		log := c.Log
		bridgev2.BeforeBackfillTask = func(ctx context.Context) {
			if waited := c.History.WaitForRoom(ctx); waited >= time.Second {
				log.Debug().Dur("waited", waited).Msg("History waited for the server to catch up")
			}
		}
	}
}

// Start runs after bridgev2 has upgraded its database and before any login connects, so a
// message cut off by the last stop is undone before its network sends it again.
func (c *Connector) Start(ctx context.Context) error { return c.RecoverInflight(ctx) }

// remoteEventDone settles the messages a watched remote event was bridging (handled): once
// handling ended, they're no longer in flight, and if it failed, what of them bridgev2 saved is
// forgotten. bridgev2 drops a redelivered message as a duplicate once any part of it is saved,
// so without that a message whose second part failed would never get it; the parts already
// journaled come again with the same event IDs and are applied once.
func (c *Connector) remoteEventDone(evt bridgev2.RemoteEvent, res bridgev2.EventHandlingResult) {
	// Last, once the outcome is settled and reported: the next attempt at the message goes then.
	defer c.messages.done(evt)
	messages, watched := handled.Messages(evt)
	if !watched {
		return
	}
	ctx := context.Background()
	if c.Bridge != nil && c.Bridge.BackgroundCtx != nil {
		ctx = context.WithoutCancel(c.Bridge.BackgroundCtx)
	}
	succeeded := res.Success
	// Settled before the outcome is reported: the handler acknowledges on it, and a record
	// left after the acknowledgement would have the next start undo a message the network
	// won't send again. One that can't be cleared is reported failed instead.
	for _, m := range messages {
		if err := c.settleInflight(ctx, store.InflightMessage{Receiver: m.Receiver, MessageID: m.ID}, !res.Success); err != nil {
			c.Log.Err(err).Msg("Settling a bridged message failed; it is settled at the next start")
			succeeded = false
		}
	}
	// A redelivery bridgev2 took for a duplicate of a message another attempt is still
	// bridging (its parts in flight) is refused, so the network sends it again later, rather
	// than acknowledged while that attempt may yet fail and undo its parts.
	if succeeded && res.Ignored && len(messages) == 0 {
		if m, ok := remoteMessage(evt); ok {
			inflight, err := c.Store.IsInflight(ctx, m)
			if err != nil || inflight {
				succeeded = false
			}
		}
	}
	handled.Finished(evt, succeeded)
}

// remoteMessage names the message a remote event brings, if it brings one.
func remoteMessage(evt bridgev2.RemoteEvent) (store.InflightMessage, bool) {
	switch evt.GetType() {
	case bridgev2.RemoteEventMessage, bridgev2.RemoteEventMessageUpsert:
		if msg, ok := evt.(bridgev2.RemoteMessage); ok {
			return store.InflightMessage{Receiver: string(evt.GetPortalKey().Receiver), MessageID: string(msg.GetID())}, true
		}
	}
	return store.InflightMessage{}, false
}

// remoteEventStart holds evt's message (messageLocks) and, holding it, settles what an earlier
// attempt left unsettled: an in-flight record still there means that attempt's cleanup
// failed (the database was down, say) with some of its parts saved. They are undone before
// bridgev2 looks for a duplicate, which it would otherwise find in them: WhatsApp's upsert
// answers plain success then, and the partial message would be acknowledged. If they can't be
// undone either, this delivery is reported failed, so it isn't acknowledged, whatever bridgev2
// makes of it.
func (c *Connector) remoteEventStart(evt bridgev2.RemoteEvent) {
	m, held := c.messages.start(evt)
	if !held {
		return
	}
	ctx := context.Background()
	if c.Bridge != nil && c.Bridge.BackgroundCtx != nil {
		ctx = context.WithoutCancel(c.Bridge.BackgroundCtx)
	}
	inflight, err := c.Store.IsInflight(ctx, m)
	if err == nil && inflight {
		err = c.settleInflight(ctx, m, true)
	}
	if err != nil {
		c.Log.Err(err).Msg("Settling an earlier attempt at a message failed; leaving this one unacknowledged")
		handled.Fail(evt)
	}
}

// settleInflight ends a message's in-flight record, first forgetting its saved parts if undo.
func (c *Connector) settleInflight(ctx context.Context, m store.InflightMessage, undo bool) error {
	if undo {
		if err := undoParts(c, ctx, m); err != nil {
			return err
		}
	}
	return c.Store.DeleteInflight(ctx, m)
}

// undoParts forgets the parts of a message bridgev2 saved; tests replace it.
var undoParts = func(c *Connector, ctx context.Context, m store.InflightMessage) error {
	return c.Bridge.DB.Message.DeleteAllParts(ctx, networkid.UserLoginID(m.Receiver), networkid.MessageID(m.MessageID))
}

// RecoverInflight undoes the messages whose handling the last stop cut off: they weren't
// acknowledged, so their network sends them again, and bridgev2 must not take that for a
// duplicate of the parts it had saved.
func (c *Connector) RecoverInflight(ctx context.Context) error {
	messages, err := c.Store.Inflight(ctx)
	if err != nil {
		return fmt.Errorf("failed to list messages being bridged: %w", err)
	}
	for _, m := range messages {
		if err = c.settleInflight(ctx, m, true); err != nil {
			return fmt.Errorf("failed to undo a message cut off by the last stop: %w", err)
		}
	}
	if len(messages) > 0 {
		c.Log.Info().Int("messages", len(messages)).Msg("Undid messages cut off by the last stop, for their redelivery")
	}
	return nil
}
func (c *Connector) PreStop() {}
func (c *Connector) Stop()    {}

// BotIntent satisfies the unexported interface bridgev2.NewBridge asserts.
func (c *Connector) BotIntent() bridgev2.MatrixAPI { return c.bot }

func (c *Connector) GetCapabilities() *bridgev2.MatrixCapabilities {
	return &bridgev2.MatrixCapabilities{
		// Members are recorded when a room is created rather than invited and joined one
		// by one, since nobody needs to accept anything.
		AutoJoinInvites: true,
		// History beyond the initial sync arrives through BatchSend. This is the capability
		// a standard homeserver lacks.
		BatchSending:          true,
		ArbitraryMemberChange: true,
	}
}

func (c *Connector) ParseGhostMXID(userID id.UserID) (networkid.UserID, bool) {
	return ids.ParseGhostMXID(userID)
}

func (c *Connector) FormatGhostMXID(userID networkid.UserID) id.UserID {
	return ids.GhostMXID(userID)
}

func (c *Connector) GhostIntent(userID networkid.UserID) bridgev2.MatrixAPI {
	intent, _ := c.ghosts.GetOrSet(userID, &Intent{c: c, mxid: ids.GhostMXID(userID), kind: intentGhost, ghostID: userID})
	return intent
}

// NewUserIntent is how bridgev2 gets a double puppet. Every person is always double
// puppeted here, so their own messages, from any device, are attributed to them.
func (c *Connector) NewUserIntent(ctx context.Context, userID id.UserID, accessToken string) (bridgev2.MatrixAPI, string, error) {
	trioditisID, ok := ids.ParseUserMXID(userID)
	if !ok {
		return nil, "", fmt.Errorf("%s is not a Trioditis user", userID)
	}
	if accessToken == "" {
		accessToken = "trioditis"
	}
	return &Intent{c: c, mxid: userID, kind: intentUser, userID: trioditisID}, accessToken, nil
}

func (c *Connector) ServerName() string { return ids.ServerName }

func (c *Connector) GenerateDeterministicRoomID(portalKey networkid.PortalKey) id.RoomID {
	return ids.RoomID(portalKey)
}

func (c *Connector) GenerateDeterministicEventID(_ id.RoomID, portalKey networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	return ids.MessageEventID(portalKey, messageID, partID)
}

func (c *Connector) GenerateReactionEventID(_ id.RoomID, targetMessage *database.Message, sender networkid.UserID, emojiID networkid.EmojiID) id.EventID {
	if targetMessage == nil {
		return ids.LocalEventID("reaction-without-target", string(sender), string(emojiID))
	}
	return ids.ReactionEventID(targetMessage.Room, targetMessage.ID, targetMessage.PartID, sender, emojiID)
}

// GenerateContentURI is only used for direct media, which the bridge host doesn't enable:
// files are always reuploaded into the encrypted store.
func (c *Connector) GenerateContentURI(ctx context.Context, mediaID networkid.MediaID) (id.ContentURIString, error) {
	return "", errors.New("direct media is not supported by the Trioditis bridge host")
}

func (c *Connector) ParseContentURI(ctx context.Context, contentURI id.ContentURIString) (networkid.MediaID, error) {
	return nil, errors.New("direct media is not supported by the Trioditis bridge host")
}

// GetPowerLevels returns levels that let every member do everything. Nothing in Trioditis
// is moderated through Matrix power levels.
func (c *Connector) GetPowerLevels(ctx context.Context, roomID id.RoomID) (*event.PowerLevelsEventContent, error) {
	return &event.PowerLevelsEventContent{Users: map[id.UserID]int{ids.BotMXID: 9001}}, nil
}

func (c *Connector) GetMembers(ctx context.Context, roomID id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	members, err := c.Store.Members(ctx, string(roomID))
	if err != nil {
		return nil, err
	}
	out := make(map[id.UserID]*event.MemberEventContent, len(members))
	for _, mxid := range members {
		out[id.UserID(mxid)] = &event.MemberEventContent{Membership: event.MembershipJoin}
	}
	return out, nil
}

func (c *Connector) GetMemberInfo(ctx context.Context, roomID id.RoomID, userID id.UserID) (*event.MemberEventContent, error) {
	members, err := c.GetMembers(ctx, roomID)
	if err != nil {
		return nil, err
	}
	return members[userID], nil
}

// SendBridgeStatus reports a login's connection state as a loginState event.
func (c *Connector) SendBridgeStatus(ctx context.Context, state *status.BridgeState) error {
	if state.RemoteID == "" || state.UserID == "" {
		// The bridge's own state, not a login's. There is nobody to tell.
		return nil
	}
	userID, ok := ids.ParseUserMXID(state.UserID)
	if !ok {
		return nil
	}
	// Only a code leaves the bridge host; the connector's message is logged locally.
	var mapped, code string
	switch state.StateEvent {
	case status.StateConnecting:
		mapped = "CONNECTING"
	case status.StateConnected, status.StateBackfilling:
		mapped = "CONNECTED"
	case status.StateTransientDisconnect:
		mapped, code = "TRANSIENT_DISCONNECT", protocol.ErrNotConnected
	case status.StateBadCredentials:
		mapped, code = "BAD_CREDENTIALS", protocol.ErrBadCredentials
	case status.StateUnknownError:
		mapped, code = "UNKNOWN_ERROR", protocol.ErrInternal
	case status.StateLoggedOut:
		mapped = "LOGGED_OUT"
	default:
		return nil
	}
	if code != "" {
		c.Log.Warn().Str("state", mapped).Str("error", string(state.Error)).Msg("Login isn't connected")
	}
	loginID, err := c.loginOpaque(ctx, networkid.UserLoginID(state.RemoteID))
	if err != nil {
		return err
	}
	evt := &protocol.Event{
		Type: protocol.EventLoginState, UserID: userID, LoginID: loginID,
		State: mapped, Error: code,
	}
	if hint := accountHint(state); hint != "" && mapped != "LOGGED_OUT" {
		// Sealed to the person only, never an agent key: it names their account.
		sealed, err := c.seal(ctx, &owner{userID: userID, loginID: loginID}, seal.KindAccount, loginID, protocol.AccountPlaintext{Hint: hint})
		if err != nil {
			// The state still goes; the account is told apart by less until the next one.
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Sealing an account's hint failed")
		} else {
			evt.Sealed = sealed
		}
	}
	return c.emit(ctx, evt)
}

// maxAccountHint bounds an account's hint, well inside the sealed metadata limit.
const maxAccountHint = 256

// accountHint is what tells a login's account apart from the person's others on the network,
// from what the connector says about it: its number, username, email or name, in that order.
func accountHint(state *status.BridgeState) string {
	p := state.RemoteProfile
	hint := p.Phone
	switch {
	case hint != "":
	case p.Username != "":
		hint = "@" + strings.TrimPrefix(p.Username, "@")
	case p.Email != "":
		hint = p.Email
	case p.Name != "":
		hint = p.Name
	default:
		hint = state.RemoteName
	}
	if len(hint) > maxAccountHint {
		hint = hint[:maxAccountHint]
		for !utf8.ValidString(hint) {
			hint = hint[:len(hint)-1]
		}
	}
	return hint
}

// BatchSend receives history. Each event already carries its deterministic ID.
func (c *Connector) BatchSend(ctx context.Context, roomID id.RoomID, req *mautrix.ReqBeeperBatchSend, extras []*bridgev2.MatrixSendExtra) (*mautrix.RespBeeperBatchSend, error) {
	owner, err := c.owner(ctx, roomID)
	if err != nil {
		return nil, err
	}
	resp := &mautrix.RespBeeperBatchSend{EventIDs: make([]id.EventID, len(req.Events))}
	// The recipients are fetched first: fetching can wait on the gateway, and nothing slow may
	// run while the transaction below holds the database writer, or other chats' writes (a
	// send's mapping, say) would wait behind it.
	recipients, err := c.Keys.Recipients(ctx, owner.userID, owner.portalID)
	if err != nil {
		return nil, fmt.Errorf("can't seal for %s: %w", owner.userID, err)
	}
	ctx = withRecipients(ctx, owner, recipients)
	// The whole batch goes into the journal in one transaction, so a failure part-way leaves
	// none of it for bridgev2 to retry around. (Every event also has a deterministic ID, so
	// even a replayed batch is stored once by Convex.)
	err = c.Store.Txn(ctx, func(ctx context.Context) error {
		for i, evt := range req.Events {
			resp.EventIDs[i] = evt.ID
			sender, ok := c.senderForMXID(evt.Sender)
			if !ok {
				continue
			}
			if err := c.emitContent(ctx, owner, sender, evt.Type, &evt.Content, evt.ID, time.UnixMilli(evt.Timestamp), true); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// emit writes an event to the journal. Content fields must already be sealed.
func (c *Connector) emit(ctx context.Context, evt *protocol.Event) error {
	if evt.At == 0 {
		evt.At = time.Now().UnixMilli()
	}
	if err := c.Store.Append(ctx, evt); err != nil {
		return err
	}
	c.Notify()
	return nil
}

// owner is who a room belongs to. With split portals every portal has a receiver login,
// and that login belongs to exactly one person.
type owner struct {
	key      networkid.PortalKey
	roomID   id.RoomID
	userID   string
	login    networkid.UserLoginID
	loginID  string // opaque
	portalID string // opaque
}

var errNotPortal = errors.New("room is not a portal")

// errNoLogin is a portal whose login is gone (logged out), though rooms of it may still be
// recorded.
var errNoLogin = errors.New("portal has no login")

func (c *Connector) owner(ctx context.Context, roomID id.RoomID) (*owner, error) {
	key, ok := ids.ParseRoomID(roomID)
	if !ok || key.Receiver == "" {
		return nil, fmt.Errorf("%w: %s", errNotPortal, roomID)
	}
	login, err := c.Bridge.DB.UserLogin.GetByID(ctx, key.Receiver)
	if err != nil {
		return nil, err
	} else if login == nil {
		return nil, fmt.Errorf("%w: %s", errNoLogin, roomID)
	}
	userID, ok := ids.ParseUserMXID(login.UserMXID)
	if !ok {
		return nil, fmt.Errorf("login %s belongs to %s, which isn't a Trioditis user", login.ID, login.UserMXID)
	}
	o := &owner{key: key, roomID: roomID, userID: userID, login: key.Receiver}
	if o.loginID, err = c.loginOpaque(ctx, key.Receiver); err != nil {
		return nil, err
	}
	if o.portalID, err = c.portalOpaqueForRoom(ctx, roomID); err != nil {
		return nil, err
	}
	return o, nil
}

func (c *Connector) opaque(ctx context.Context, kind, value string) (string, error) {
	opaque := c.Opaque.ID(c.Network, kind, value)
	return opaque, c.Store.PutID(ctx, opaque, kind, value)
}

func (c *Connector) loginOpaque(ctx context.Context, login networkid.UserLoginID) (string, error) {
	return c.opaque(ctx, ids.KindLogin, string(login))
}

// portalOpaqueForRoom is a portal's opaque ID: a hash of the portal key its room was
// created with (which the room ID encodes), stored as the room ID. The room ID never
// changes, even when the network re-IDs the portal, so neither does the opaque ID.
func (c *Connector) portalOpaqueForRoom(ctx context.Context, roomID id.RoomID) (string, error) {
	original, ok := ids.ParseRoomID(roomID)
	if !ok {
		return "", fmt.Errorf("%w: %s", errNotPortal, roomID)
	}
	opaque := c.Opaque.ID(c.Network, ids.KindPortal, ids.PortalValue(original))
	return opaque, c.Store.PutID(ctx, opaque, ids.KindPortal, string(roomID))
}

// portalOpaqueForKey finds a portal's opaque ID from its current key, through its room.
func (c *Connector) portalOpaqueForKey(ctx context.Context, key networkid.PortalKey) (string, error) {
	roomID := ids.RoomID(key)
	if portal, err := c.Bridge.GetExistingPortalByKey(ctx, key); err != nil {
		return "", err
	} else if portal != nil && portal.MXID != "" {
		roomID = portal.MXID
	}
	return c.portalOpaqueForRoom(ctx, roomID)
}

func (c *Connector) ghostOpaque(ctx context.Context, ghost networkid.UserID) (string, error) {
	return c.opaque(ctx, ids.KindGhost, string(ghost))
}

func (c *Connector) seal(ctx context.Context, o *owner, kind seal.Kind, objectID string, value any) (*seal.Envelope, error) {
	recipients, ok := prefetchedRecipients(ctx, o)
	if !ok {
		var err error
		if recipients, err = c.Keys.Recipients(ctx, o.userID, o.portalID); err != nil {
			return nil, fmt.Errorf("can't seal for %s: %w", o.userID, err)
		}
	}
	return seal.SealJSON(value, recipients, seal.Context{Kind: kind, OwnerUserID: o.userID, ObjectID: objectID})
}

// prefetched carries recipients fetched before a transaction, so sealing inside it never
// waits on the gateway.
type prefetched struct {
	userID, portalID string
	recipients       []seal.PublicKey
}

type prefetchedKey struct{}

func withRecipients(ctx context.Context, o *owner, recipients []seal.PublicKey) context.Context {
	return context.WithValue(ctx, prefetchedKey{}, &prefetched{userID: o.userID, portalID: o.portalID, recipients: recipients})
}

func prefetchedRecipients(ctx context.Context, o *owner) ([]seal.PublicKey, bool) {
	p, ok := ctx.Value(prefetchedKey{}).(*prefetched)
	if !ok || p.userID != o.userID || len(p.recipients) == 0 {
		return nil, false
	}
	if o.portalID == "" {
		// Sealed to the person only (a contact): their identity key comes first.
		return p.recipients[:1], true
	}
	if p.portalID != o.portalID {
		return nil, false
	}
	return p.recipients, true
}

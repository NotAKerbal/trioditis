// Package connector is Trioditis's own bridgev2 MatrixConnector. bridgev2's network
// connectors (WhatsApp, Signal, …) talk to it as if it were a Matrix homeserver; it turns
// what they "send to Matrix" into sealed protocol events in the journal, and turns gateway
// commands into the Matrix-side events bridgev2 expects. No homeserver exists.
package connector

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exsync"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/keys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
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
	// busy holds chats (by opaque portal ID) with a send in flight; the worker runs their
	// next command once it settles.
	busy sync.Map // portal ID → id.EventID
	// lanes holds chats (by opaque portal ID) whose command is running on its own goroutine.
	lanes        sync.Map // portal ID → struct{}
	lanesRunning sync.WaitGroup
	wake         chan struct{}
}

var (
	_ bridgev2.MatrixConnector = (*Connector)(nil)
)

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
}

func (c *Connector) Start(ctx context.Context) error { return nil }
func (c *Connector) PreStop()                        {}
func (c *Connector) Stop()                           {}

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
	return c.emit(ctx, &protocol.Event{
		Type: protocol.EventLoginState, UserID: userID, LoginID: loginID,
		State: mapped, Error: code,
	})
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

func (c *Connector) owner(ctx context.Context, roomID id.RoomID) (*owner, error) {
	key, ok := ids.ParseRoomID(roomID)
	if !ok || key.Receiver == "" {
		return nil, fmt.Errorf("%w: %s", errNotPortal, roomID)
	}
	login, err := c.Bridge.DB.UserLogin.GetByID(ctx, key.Receiver)
	if err != nil {
		return nil, err
	} else if login == nil {
		return nil, fmt.Errorf("portal %s has no login", roomID)
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

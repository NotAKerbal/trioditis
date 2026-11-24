package imessage

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/ptr"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// Client is one login: one person's Mac.
type Client struct {
	conn  *Connector
	login *bridgev2.UserLogin
	// bb is nil when the login's details can't make a client (a server address that no
	// longer parses); the login then reports bad credentials.
	bb *bluebubbles.Client

	// privateAPI is whether the server's Private API helper was running when last asked.
	privateAPI atomic.Bool

	// acker waits for bridgev2's real outcome for each new message (nil in unit tests).
	acker *handled.Acker
	// failures counts, per message GUID, the catch-ups that couldn't hand it over, so one
	// message bridgev2 never takes holds catch-up back only so many times.
	failLock sync.Mutex
	failures map[string]*attempts
	// queue holds the socket's events until they are handled, across reconnects.
	queue *eventQueue
	// now, in tests, stands in for the clock.
	now func() time.Time
	// take, in tests, stands in for handing a message to bridgev2 (handleNewMessage).
	take func(*bluebubbles.Message) bool

	runLock sync.Mutex
	stop    context.CancelFunc
	done    chan struct{}

	// syncLock is held while recording the time synced up to, which catching up and the
	// connection's ticker both do.
	syncLock sync.Mutex

	// lastRead is the newest message each chat was last reported read up to, by the other
	// person (DM read receipts come again with every later change to the message).
	lastRead sync.Map // networkid.PortalID → string
}

var (
	_ bridgev2.NetworkAPI                    = (*Client)(nil)
	_ bridgev2.BackfillingNetworkAPI         = (*Client)(nil)
	_ bridgev2.EditHandlingNetworkAPI        = (*Client)(nil)
	_ bridgev2.ReactionHandlingNetworkAPI    = (*Client)(nil)
	_ bridgev2.RedactionHandlingNetworkAPI   = (*Client)(nil)
	_ bridgev2.ReadReceiptHandlingNetworkAPI = (*Client)(nil)
	_ bridgev2.TypingHandlingNetworkAPI      = (*Client)(nil)
	_ bridgev2.IdentifierResolvingNetworkAPI = (*Client)(nil)
)

func newClient(c *Connector, login *bridgev2.UserLogin) *Client {
	client := &Client{conn: c, login: login, failures: map[string]*attempts{}, queue: newEventQueue()}
	if c.bridge != nil {
		// The bridge's logger, not the login's.
		client.acker = handled.NewAcker(c.bridge.BackgroundCtx, c.bridge.Log.With().Str("component", "imessage ack").Logger())
	}
	if meta, ok := login.Metadata.(*LoginMetadata); ok && meta.ServerURL != "" {
		client.bb, _ = bluebubbles.New(meta.ServerURL, meta.Password, c.allow)
	}
	return client
}

func (c *Client) meta() *LoginMetadata {
	meta, _ := c.login.Metadata.(*LoginMetadata)
	if meta == nil {
		meta = &LoginMetadata{}
		c.login.Metadata = meta
	}
	return meta
}

func (c *Client) IsLoggedIn() bool { return c.bb != nil }

// LogoutRemote: BlueBubbles has no session to end; the login's details go with the login.
func (c *Client) LogoutRemote(ctx context.Context) { c.Disconnect() }

func (c *Client) IsThisUser(ctx context.Context, userID networkid.UserID) bool {
	return userID == c.selfID()
}

// Connect starts the login's connection to its Mac, which keeps itself up until Disconnect.
func (c *Client) Connect(ctx context.Context) {
	if c.bb == nil {
		c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateBadCredentials, Error: "imessage-invalid-login"})
		return
	}
	c.runLock.Lock()
	defer c.runLock.Unlock()
	if c.stop != nil {
		return
	}
	runCtx, cancel := context.WithCancel(c.login.Log.WithContext(context.Background()))
	c.stop, c.done = cancel, make(chan struct{})
	go c.run(runCtx, c.done)
}

func (c *Client) Disconnect() {
	c.runLock.Lock()
	stop, done := c.stop, c.done
	c.stop, c.done = nil, nil
	c.runLock.Unlock()
	if stop != nil {
		stop()
		<-done
	}
}

// Reconnecting waits from minBackoff, doubling to maxBackoff; a connection that stayed up
// for stableAfter starts the wait over.
const (
	minBackoff  = 2 * time.Second
	maxBackoff  = 5 * time.Minute
	stableAfter = time.Minute
)

func (c *Client) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	log := zerolog.Ctx(ctx)
	backoff := minBackoff
	for ctx.Err() == nil {
		c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnecting})
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		var bbErr *bluebubbles.Error
		if errors.Is(err, bluebubbles.ErrSocketRefused) || errors.As(err, &bbErr) && bbErr.Unauthorized() {
			// The password was changed on the Mac: only signing in again can fix that.
			log.Warn().Msg("BlueBubbles Server refused the password")
			c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateBadCredentials, Error: "imessage-wrong-password"})
			return
		}
		// Only the error's type: its text can carry the server's address.
		log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Lost the connection to BlueBubbles Server")
		c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateTransientDisconnect, Error: "imessage-unreachable"})
		if time.Since(started) > stableAfter {
			backoff = minBackoff
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// infoInterval is how often a connected login asks the server whether its Private API
// helper is running, which can change while the Mac is up.
const infoInterval = 5 * time.Minute

// session is one connection. It asks the server about itself and opens the socket; once the
// socket is up it catches up on what happened while the login was away, and only then hands
// over the live events the socket brought meanwhile, in order. A live message is never handled
// before the catch-up that would bring in an earlier one, so none is skipped.
func (c *Client) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := c.refreshInfo(ctx); err != nil {
		return err
	}
	// The socket never waits on handling: it must keep answering the server's pings while a
	// catch-up runs or a chat is busy with a send. Events wait in the login's queue instead,
	// which outlives the connection: an edit or unsend read before the connection dropped is
	// handed over after the next catch-up, which can't fetch it again.
	queue := c.queue
	var caughtUp atomic.Bool
	var failure error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		c.keepUp(ctx, func() bool { return caughtUp.Load() && queue.pending() == 0 })
	}()
	started := false
	err := c.bb.Listen(ctx, func() {
		if started {
			return
		}
		started = true
		c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.catchUp(ctx, time.Now()); err != nil {
				failure = err
				cancel()
				return
			}
			caughtUp.Store(true)
			for {
				evt, ok := queue.pop(ctx)
				if !ok {
					return
				}
				failedAt := c.handleEvent(ctx, evt)
				if failedAt != 0 {
					// bridgev2 couldn't take a message: fetch it again from the Mac. If even
					// that fails, the session ends, and the next one catches up from before it.
					if err := c.catchUpSince(ctx, failedAt-catchUpMargin.Milliseconds()); err != nil {
						failure = err
						cancel()
						return
					}
				}
				queue.done()
			}
		}()
	}, queue.push)
	cancel()
	wg.Wait()
	if failure != nil {
		return failure
	}
	return err
}

// eventQueue holds the socket's events, in order, until they are handled. It never refuses
// one: what a reconnect would otherwise fetch again is only memory.
type eventQueue struct {
	lock  sync.Mutex
	items []bluebubbles.Event
	// count is the events pushed and not yet done, the one being handled included.
	count int
	wake  chan struct{}
}

func newEventQueue() *eventQueue { return &eventQueue{wake: make(chan struct{}, 1)} }

func (q *eventQueue) push(evt bluebubbles.Event) {
	q.lock.Lock()
	q.items = append(q.items, evt)
	q.count++
	q.lock.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *eventQueue) pop(ctx context.Context) (bluebubbles.Event, bool) {
	for {
		// A session that ended hands nothing more over: the next one catches up instead.
		if ctx.Err() != nil {
			return bluebubbles.Event{}, false
		}
		q.lock.Lock()
		if len(q.items) > 0 {
			evt := q.items[0]
			q.items[0] = bluebubbles.Event{}
			q.items = q.items[1:]
			q.lock.Unlock()
			return evt, true
		}
		q.lock.Unlock()
		select {
		case <-ctx.Done():
			return bluebubbles.Event{}, false
		case <-q.wake:
		}
	}
}

func (q *eventQueue) done() {
	q.lock.Lock()
	q.count--
	q.lock.Unlock()
}

func (q *eventQueue) pending() int {
	q.lock.Lock()
	defer q.lock.Unlock()
	return q.count
}

func (c *Client) refreshInfo(ctx context.Context) error {
	info, err := c.bb.ServerInfo(ctx)
	if err != nil {
		return err
	}
	c.privateAPI.Store(info.PrivateAPI && info.HelperConnected)
	if info.DetectedIMessage != "" && info.DetectedIMessage != c.login.RemoteName {
		c.login.RemoteName = info.DetectedIMessage
		if err = c.login.Save(ctx); err != nil {
			zerolog.Ctx(ctx).Err(err).Msg("Failed to save the login's account name")
		}
	}
	return nil
}

// syncInterval is how often a connected login records the time it is synced up to.
const syncInterval = time.Minute

// keepUp, while connected, records how far the login is synced, while settled says nothing is
// waiting to be handled, and checks on the Private API now and then.
func (c *Client) keepUp(ctx context.Context, settled func() bool) {
	syncTick := time.NewTicker(syncInterval)
	infoTick := time.NewTicker(infoInterval)
	defer syncTick.Stop()
	defer infoTick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-infoTick.C:
			if err := c.refreshInfo(ctx); err != nil && ctx.Err() == nil {
				zerolog.Ctx(ctx).Debug().Str("error_type", fmt.Sprintf("%T", err)).Msg("Couldn't ask BlueBubbles Server about itself")
			}
		case now := <-syncTick.C:
			// Everything that arrived before the last tick has been handled.
			if settled() {
				c.markSynced(ctx, now.Add(-syncInterval))
			}
		}
	}
}

func (c *Client) markSynced(ctx context.Context, at time.Time) {
	c.syncLock.Lock()
	defer c.syncLock.Unlock()
	meta := c.meta()
	if at.UnixMilli() <= meta.SyncedUpTo {
		return
	}
	// Kept in memory only once saved: one that isn't saved isn't moved on, so a later save
	// can't carry a time past what was never recorded.
	before := meta.SyncedUpTo
	meta.SyncedUpTo = at.UnixMilli()
	if err := c.login.Save(ctx); err != nil {
		meta.SyncedUpTo = before
		if ctx.Err() == nil {
			zerolog.Ctx(ctx).Err(err).Msg("Failed to save how far the login is synced")
		}
	}
}

const (
	// initialChats is how many of the most recent chats a new login brings in.
	initialChats = 50
	// catchUpMargin is how far before the time last synced a catch-up looks, for events
	// that were on their way when the connection went.
	catchUpMargin = 5 * time.Minute
	// chatPage is the most chats the server lists at once; maxChats bounds a listing.
	chatPage = 1000
	maxChats = 20 * chatPage
	// messagePage is how many missed messages are fetched at once; maxCatchUp bounds one
	// catch-up, past which the rest of a long absence is left to history.
	messagePage = 500
	maxCatchUp  = 20000
)

// catchUp brings in what happened while the login wasn't connected: every message created
// since a little before the time it last synced up to, in every chat, oldest first, as if it
// had come over the socket. A new login brings in its most recent chats instead, with their
// recent history. connectedAt is when the socket came up: what came after is on the socket.
func (c *Client) catchUp(ctx context.Context, connectedAt time.Time) error {
	c.syncLock.Lock()
	since := c.meta().SyncedUpTo
	c.syncLock.Unlock()
	var err error
	if since == 0 {
		err = c.initialSync(ctx)
	} else {
		err = c.catchUpSince(ctx, since-catchUpMargin.Milliseconds())
	}
	if err != nil {
		return err
	}
	c.markSynced(ctx, connectedAt.Add(-catchUpMargin))
	return nil
}

// errNotTaken is a catch-up in which bridgev2 couldn't take a message: the time synced up to
// stays, and the next catch-up fetches it again.
var errNotTaken = errors.New("imessage: a caught-up message couldn't be bridged")

// maxAttempts is how many catch-ups a message bridgev2 won't take holds back, counted at
// most once per attemptSpacing, so a short outage (the database restarting, say) that fails
// every message uses up no more than one. Past that the message is left, and logged, so one
// message can't keep a login from ever catching up.
const (
	maxAttempts    = 3
	attemptSpacing = 10 * time.Minute
)

// attempts is one message's failed catch-ups: how many were counted, and when the last was.
type attempts struct {
	count int
	last  time.Time
}

// handOver hands a caught-up message over, and says whether catching up must stop short of
// it (holdBack).
func (c *Client) handOver(ctx context.Context, msg *bluebubbles.Message) bool {
	take := c.handleNewMessage
	if c.take != nil {
		take = c.take
	}
	return c.holdBack(ctx, "message:"+msg.GUID, take(msg))
}

// holdBack says whether something a catch-up couldn't bring in (ok false) must keep the time
// synced up to where it is, so the next catch-up tries again: until it has failed maxAttempts
// times, counted at most once per attemptSpacing. Something that went in is forgotten.
func (c *Client) holdBack(ctx context.Context, key string, ok bool) bool {
	c.failLock.Lock()
	defer c.failLock.Unlock()
	if ok {
		delete(c.failures, key)
		return false
	}
	now := time.Now()
	if c.now != nil {
		now = c.now()
	}
	a := c.failures[key]
	if a == nil {
		a = &attempts{}
		c.failures[key] = a
	}
	if a.count == 0 || now.Sub(a.last) >= attemptSpacing {
		a.count++
		a.last = now
	}
	if a.count < maxAttempts {
		return true
	}
	delete(c.failures, key)
	zerolog.Ctx(ctx).Error().Int("attempts", maxAttempts).Msg("Something couldn't be bridged after repeated catch-ups; leaving it")
	return false
}

// catchUpSince hands over every message created at or after after (Unix ms), oldest first.
// Ones already bridged are recognized by their GUIDs. It fails, so the time synced up to
// stays, if the Mac can't be asked or bridgev2 couldn't take a message (handOver).
func (c *Client) catchUpSince(ctx context.Context, after int64) error {
	notTaken := false
	offset := 0
	for offset < maxCatchUp {
		page, err := c.bb.MessagesSince(ctx, after, offset, messagePage)
		if err != nil {
			return err
		}
		for i := range page {
			msg := &page[i]
			if msg.ItemType != 0 {
				// A rename, or someone added or leaving: the chat's details are fetched again.
				if guid := msg.ChatGUID(); guid != "" {
					_ = c.queueResync(ctx, guid, time.Time{}, false)
				}
				continue
			}
			if c.handOver(ctx, msg) {
				notTaken = true
			}
		}
		if len(page) < messagePage {
			break
		}
		offset += len(page)
	}
	if offset >= maxCatchUp {
		zerolog.Ctx(ctx).Warn().Int("messages", maxCatchUp).Msg("Caught up as far as one catch-up goes; older missed messages are left to history")
	}
	if notTaken {
		return errNotTaken
	}
	return nil
}

// initialSync brings in a new login's most recent chats, with their recent history. The
// server lists chats in pages by when they were made, so every page is read before the most
// recently active are picked.
func (c *Client) initialSync(ctx context.Context) error {
	var chats []bluebubbles.Chat
	for offset := 0; offset < maxChats; offset += chatPage {
		page, err := c.bb.Chats(ctx, offset, chatPage)
		if err != nil {
			return err
		}
		chats = append(chats, page...)
		if len(page) < chatPage {
			break
		}
	}
	last := func(chat *bluebubbles.Chat) int64 {
		if chat.LastMessage == nil {
			return 0
		}
		return chat.LastMessage.DateCreated
	}
	slices.SortStableFunc(chats, func(a, b bluebubbles.Chat) int { return cmp.Compare(last(&b), last(&a)) })
	notTaken := false
	for i := range chats[:min(len(chats), initialChats)] {
		if at := last(&chats[i]); at > 0 {
			// A chat bridgev2 couldn't make keeps the login from counting as synced, so the
			// next connection makes it again rather than leaving it out until it gets a new
			// message.
			ok := c.queueResync(ctx, chats[i].GUID, time.UnixMilli(at), true)
			if c.holdBack(ctx, "chat:"+string(chatID(chats[i].GUID)), ok) {
				notTaken = true
			}
		}
	}
	if notTaken {
		return errNotTaken
	}
	return nil
}

// queueResync has bridgev2 update a chat's details, and fetch its messages up to latest, and
// says whether it could.
func (c *Client) queueResync(ctx context.Context, chatGUID string, latest time.Time, create bool) bool {
	res := c.login.QueueRemoteEvent(&simplevent.ChatResync{
		EventMeta: simplevent.EventMeta{
			Type:         bridgev2.RemoteEventChatResync,
			PortalKey:    c.portalKey(chatGUID),
			CreatePortal: create,
		},
		GetChatInfoFunc: c.GetChatInfo,
		LatestMessageTS: latest,
	})
	return res.Success || res.Ignored
}

// GetChatInfo is a chat's details: for a direct chat, who it is with (its name and picture
// are theirs); for a group, its name, picture and members.
func (c *Client) GetChatInfo(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	if address := dmAddress(portal.ID); address != "" {
		return c.dmInfo(address), nil
	}
	if c.bb == nil {
		return nil, bridgev2.ErrNotLoggedIn
	}
	chat, err := c.bb.Chat(ctx, string(portal.ID))
	if err != nil {
		return nil, err
	}
	members := &bridgev2.ChatMemberList{
		IsFull:    true,
		MemberMap: bridgev2.ChatMemberMap{},
	}
	members.MemberMap.Set(bridgev2.ChatMember{EventSender: c.sender(true, "")})
	for _, p := range chat.Participants {
		if p.Address != "" {
			members.MemberMap.Set(bridgev2.ChatMember{EventSender: c.sender(false, p.Address)})
		}
	}
	info := &bridgev2.ChatInfo{
		Type:        ptr.Ptr(database.RoomTypeDefault),
		Members:     members,
		Avatar:      c.groupAvatar(ctx, string(portal.ID)),
		CanBackfill: true,
	}
	// An unnamed group is named after its members by the app; an empty name says so.
	info.Name = ptr.Ptr(chat.DisplayName)
	return info, nil
}

func (c *Client) dmInfo(address string) *bridgev2.ChatInfo {
	other := c.userID(address)
	members := &bridgev2.ChatMemberList{
		IsFull:      true,
		OtherUserID: other,
		MemberMap:   bridgev2.ChatMemberMap{},
	}
	members.MemberMap.Set(bridgev2.ChatMember{EventSender: c.sender(true, "")})
	members.MemberMap.Set(bridgev2.ChatMember{EventSender: c.sender(false, address)})
	return &bridgev2.ChatInfo{
		Type:        ptr.Ptr(database.RoomTypeDM),
		Members:     members,
		CanBackfill: true,
	}
}

// maxAvatarBytes bounds a picture fetched for a chat or contact.
const maxAvatarBytes = 10 << 20

// groupAvatar is a group's picture, or nil if it couldn't be fetched (it is left as it is).
// It is named by its content, so a change shows and an unchanged one isn't uploaded again.
func (c *Client) groupAvatar(ctx context.Context, chatGUID string) *bridgev2.Avatar {
	body, _, err := c.bb.Download(ctx, bluebubbles.ChatIconPath(chatGUID))
	var bbErr *bluebubbles.Error
	if errors.As(err, &bbErr) && bbErr.Status == 404 {
		return &bridgev2.Avatar{ID: "", Remove: true}
	} else if err != nil {
		return nil
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxAvatarBytes))
	if err != nil || len(data) == 0 {
		return nil
	}
	return imageAvatar(data)
}

func imageAvatar(data []byte) *bridgev2.Avatar {
	sum := sha256.Sum256(data)
	return &bridgev2.Avatar{
		ID:  networkid.AvatarID(hex.EncodeToString(sum[:16])),
		Get: func(context.Context) ([]byte, error) { return data, nil },
	}
}

// GetUserInfo is a person's name and picture as the Mac's Contacts have them, or their
// address when Contacts don't know them.
func (c *Client) GetUserInfo(ctx context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	address, ok := c.address(ghost.ID)
	if !ok || ghost.ID == c.selfID() {
		return nil, nil
	}
	info := &bridgev2.UserInfo{
		Name:        ptr.Ptr(address),
		Identifiers: []string{identifierURI(address)},
		IsBot:       ptr.Ptr(false),
	}
	if c.bb == nil {
		return info, nil
	}
	contacts, err := c.bb.Contacts(ctx, []string{address})
	if err != nil {
		// Keep the address as their name; the next look will try again.
		zerolog.Ctx(ctx).Debug().Str("error_type", fmt.Sprintf("%T", err)).Msg("Couldn't look up a contact")
		return info, nil
	}
	if contact := matchContact(contacts, address); contact != nil {
		if name := contact.Name(); name != "" {
			info.Name = ptr.Ptr(name)
		}
		if contact.Avatar != "" {
			if data, err := base64.StdEncoding.DecodeString(contact.Avatar); err == nil && len(data) > 0 && len(data) <= maxAvatarBytes {
				info.Avatar = imageAvatar(data)
			}
		}
	}
	if info.Avatar == nil {
		info.Avatar = &bridgev2.Avatar{Remove: true}
	}
	return info, nil
}

func identifierURI(address string) string {
	if strings.Contains(address, "@") {
		return "mailto:" + address
	}
	return "tel:" + address
}

// matchContact is the contact with this address. The server matches loosely (by the end of a
// number), so its answer is checked.
func matchContact(contacts []bluebubbles.Contact, address string) *bluebubbles.Contact {
	want := comparable(address)
	for i := range contacts {
		for _, p := range contacts[i].PhoneNumbers {
			if comparable(p.Address) == want {
				return &contacts[i]
			}
		}
		for _, e := range contacts[i].Emails {
			if comparable(e.Address) == want {
				return &contacts[i]
			}
		}
	}
	return nil
}

// comparable is an address reduced to what identifies it: an email in lower case, or a
// number's last ten digits (Contacts often keep numbers without their country code).
func comparable(address string) string {
	address = strings.TrimSpace(address)
	if strings.Contains(address, "@") {
		return strings.ToLower(address)
	}
	digits := make([]byte, 0, len(address))
	for i := 0; i < len(address); i++ {
		if address[i] >= '0' && address[i] <= '9' {
			digits = append(digits, address[i])
		}
	}
	if len(digits) > 10 {
		digits = digits[len(digits)-10:]
	}
	return string(digits)
}

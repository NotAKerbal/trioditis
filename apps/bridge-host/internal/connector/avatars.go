package connector

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// An avatar's upload lives in memory for minutes (media.UploadTTL), but a person may only meet
// its contact much later: a network's first sync uploads every contact's picture at once, before
// any of them is in a chat, and history can take hours to arrive. So the bridge host keeps two
// things, both sealed to the bridge key only (nobody else reads them back):
//
//   - its own copy of each avatar, made as the avatar is set (keepAvatar), from which a copy is
//     made for each person when they first need it;
//   - for each person, the reference to their copy (avatarRef), recorded once metadata carrying
//     it was sent, so a later change to a name alone carries the picture they already have.
//
// A contact sent with no copy left to attach (one whose picture was uploaded before copies were
// kept) has their picture fetched from the network again (RunAvatarRepairs).

const (
	// avatarKind is what a kept reference to a person's avatar copy is sealed as.
	avatarKind seal.Kind = "avatarRef"
	// avatarKeptKind is what the reference to the bridge host's own copy is sealed as.
	avatarKeptKind seal.Kind = "avatarKept"
)

func keptAvatarContext(uri id.ContentURIString) seal.Context {
	return seal.Context{Kind: avatarKeptKind, OwnerUserID: media.KeptOwner, ObjectID: string(uri)}
}

func avatarRefContext(ownerUserID string, uri id.ContentURIString) seal.Context {
	return seal.Context{Kind: avatarKind, OwnerUserID: ownerUserID, ObjectID: string(uri)}
}

// keepAvatar makes the bridge host's own copy of an avatar while its upload lives, if it hasn't
// one. A failure is only logged: the avatar still goes to whoever has the contact now.
func (c *Connector) keepAvatar(ctx context.Context, uri id.ContentURIString) {
	if uri == "" {
		return
	}
	if _, err := c.Store.KeptAvatar(ctx, string(uri)); err == nil {
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's kept copy failed")
		return
	}
	att, err := c.Media.Keep(uri)
	if errors.Is(err, media.ErrUnavailable) {
		// Not one of the store's uploads, or already gone: nothing to keep.
		return
	}
	if err == nil {
		var sealed *seal.Envelope
		if sealed, err = seal.SealJSON(att, []seal.PublicKey{c.BridgeKey.Public}, keptAvatarContext(uri)); err == nil {
			err = c.Store.PutKeptAvatar(ctx, string(uri), sealed)
		}
	}
	if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Keeping a copy of an avatar failed")
	}
}

// avatarFor is the owner's sealed copy of an avatar, to put in a chat or contact's metadata:
// made from the upload while it lives, then the copy they were sent before (known), or else a
// new one made from the bridge host's own copy. Nil when there is none of these. The caller
// records a copy that isn't known (putAvatarRef) once the metadata carrying it is sent.
func (c *Connector) avatarFor(ctx context.Context, uri id.ContentURIString, ownerUserID string) (att *protocol.Attachment, known bool) {
	att, err := c.Media.AttachmentFor(uri, ownerUserID)
	if err == nil {
		c.keepAvatar(ctx, uri)
		return att, false
	}
	sealed, err := c.Store.AvatarRef(ctx, ownerUserID, string(uri))
	if err == nil {
		var ref protocol.Attachment
		if err = seal.OpenJSON(sealed, c.BridgeKey, avatarRefContext(ownerUserID, uri), &ref); err == nil {
			return &ref, true
		}
		// Sealed to an earlier bridge key, say: a copy is made again, as for someone new.
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("An avatar's reference couldn't be opened")
	} else if !errors.Is(err, store.ErrNotFound) {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's reference failed")
		return nil, false
	}
	return c.copyKeptAvatar(ctx, uri, ownerUserID), false
}

// putAvatarRef records the reference to the copy of an avatar a person was sent. On failure the
// next metadata sent them makes another copy.
func (c *Connector) putAvatarRef(ctx context.Context, ownerUserID string, uri id.ContentURIString, att *protocol.Attachment) {
	sealed, err := seal.SealJSON(att, []seal.PublicKey{c.BridgeKey.Public}, avatarRefContext(ownerUserID, uri))
	if err == nil {
		err = c.Store.PutAvatarRef(ctx, ownerUserID, string(uri), sealed)
	}
	if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Keeping an avatar's reference failed")
	}
}

// copyKeptAvatar makes the owner a copy of an avatar from the bridge host's own, or nil if it
// has none it can read.
func (c *Connector) copyKeptAvatar(ctx context.Context, uri id.ContentURIString, ownerUserID string) *protocol.Attachment {
	sealed, err := c.Store.KeptAvatar(ctx, string(uri))
	if errors.Is(err, store.ErrNotFound) {
		return nil
	} else if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's kept copy failed")
		return nil
	}
	var kept protocol.Attachment
	if err = seal.OpenJSON(sealed, c.BridgeKey, keptAvatarContext(uri), &kept); err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("An avatar's kept copy couldn't be opened")
		return nil
	}
	att, err := c.Media.CopyKept(kept, ownerUserID)
	if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Copying an avatar's kept copy failed")
		return nil
	}
	return att
}

// avatarRetryAfter is how long after one try a contact's picture is fetched again on demand: a
// contact the network can't give a picture for isn't asked about at every message.
const avatarRetryAfter = time.Hour

// avatarRepairs is the queue of contacts whose picture is to be fetched again.
type avatarRepairs struct {
	lock   sync.Mutex
	queue  []networkid.UserID
	queued map[networkid.UserID]bool
	tried  map[networkid.UserID]time.Time
	wake   chan struct{}
}

func (r *avatarRepairs) init() {
	if r.queued == nil {
		r.queued, r.tried, r.wake = make(map[networkid.UserID]bool), make(map[networkid.UserID]time.Time), make(chan struct{}, 1)
	}
}

func (r *avatarRepairs) wakeChan() chan struct{} {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	return r.wake
}

// queueAvatarRepair asks for a contact's picture to be fetched again, unless it already is or was
// tried lately.
func (c *Connector) queueAvatarRepair(ghost networkid.UserID) {
	r := &c.repairs
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	if r.queued[ghost] || time.Since(r.tried[ghost]) < avatarRetryAfter {
		return
	}
	r.queued[ghost] = true
	r.queue = append(r.queue, ghost)
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (c *Connector) nextAvatarRepair() (networkid.UserID, bool) {
	r := &c.repairs
	r.lock.Lock()
	defer r.lock.Unlock()
	if len(r.queue) == 0 {
		return "", false
	}
	ghost := r.queue[0]
	r.queue = r.queue[1:]
	delete(r.queued, ghost)
	r.tried[ghost] = time.Now()
	return ghost, true
}

// RunAvatarRepairs sends contacts their missing pictures until ctx ends. It first looks for
// people sent a contact whose picture they don't have (scanContactAvatars), then fetches again,
// one at a time so a long list doesn't run into the network's rate limits, the pictures of
// contacts with no copy left. A contact it can't help now is looked at again at the next start.
func (c *Connector) RunAvatarRepairs(ctx context.Context) {
	if err := c.scanContactAvatars(ctx); err != nil && ctx.Err() == nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Looking for contacts sent without their picture failed; it's tried again at the next start")
	}
	pace := c.AvatarRepairPace
	if pace == 0 {
		pace = time.Second
	}
	wake := c.repairs.wakeChan()
	for {
		ghost, ok := c.nextAvatarRepair()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-wake:
				continue
			}
		}
		if err := c.repairContactAvatar(ctx, ghost); err != nil && ctx.Err() == nil {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Fetching a contact's picture again failed; it's tried again at the next start")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(pace):
		}
	}
}

// scanContactAvatars finds each person sent a contact whose picture they don't have a copy of
// (before copies were kept, a contact who turned up in someone's chat more than
// media.UploadTTL after their picture was uploaded was sent with none, and nothing sent it again
// unless the picture changed). Where the host still has the picture, the contact is sent again
// with it; otherwise the contact's picture is queued to be fetched again.
func (c *Connector) scanContactAvatars(ctx context.Context) error {
	rooms, err := c.Store.ContactRooms(ctx)
	if err != nil {
		return err
	}
	failed := 0
	for _, room := range rooms {
		userID, ok := strings.CutPrefix(room, "contacts:")
		if !ok {
			continue
		}
		members, err := c.Store.Members(ctx, room)
		if err != nil {
			return err
		}
		for _, mxid := range members {
			if err = ctx.Err(); err != nil {
				return err
			}
			ghost, ok := ids.ParseGhostMXID(id.UserID(mxid))
			if !ok {
				continue
			}
			if err = c.scanContactAvatar(ctx, userID, ghost); err != nil {
				failed++
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d contacts' pictures couldn't be looked at", failed)
	}
	return nil
}

func (c *Connector) scanContactAvatar(ctx context.Context, userID string, ghost networkid.UserID) error {
	dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghost)
	if err != nil || dbGhost == nil || dbGhost.AvatarMXC == "" {
		return err
	}
	if _, ours := media.ParseContentURI(dbGhost.AvatarMXC); !ours {
		return nil
	}
	if _, err = c.Store.AvatarRef(ctx, userID, string(dbGhost.AvatarMXC)); err == nil {
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if !c.Media.Available(dbGhost.AvatarMXC) {
		if _, err = c.Store.KeptAvatar(ctx, string(dbGhost.AvatarMXC)); errors.Is(err, store.ErrNotFound) {
			c.queueAvatarRepair(ghost)
			return nil
		} else if err != nil {
			return err
		}
	}
	o, err := c.anyOwnerFor(ctx, userID, ghost)
	if err != nil || o == nil {
		return err
	}
	// The host has the picture: the contact is sent again with it.
	return c.emitContact(ctx, o, ghost, nil, nil)
}

// repairContactAvatar fetches a contact's picture from the network again, through a login of
// someone who shares a chat with them, when the host has no copy of the one it has. Setting the
// new upload sends it to everyone who has the contact (ghostProfileChanged).
func (c *Connector) repairContactAvatar(ctx context.Context, ghostID networkid.UserID) error {
	dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghostID)
	if err != nil || dbGhost == nil || dbGhost.AvatarMXC == "" {
		return err
	}
	stale := dbGhost.AvatarMXC
	if _, ours := media.ParseContentURI(stale); !ours || c.Media.Available(stale) {
		return nil
	} else if _, err = c.Store.KeptAvatar(ctx, string(stale)); err == nil {
		// Got since it was queued, so sent to everyone who has the contact.
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	login, err := c.loginSharingChatWith(ctx, ghostID)
	if err != nil || login == nil {
		return err
	}
	ghost, err := c.Bridge.GetGhostByID(ctx, ghostID)
	if err != nil {
		return err
	}
	// bridgev2 downloads a picture again only once it has forgotten which one it has, so that is
	// forgotten first, under the ghost's lock and saved with it. The content URI stays until a
	// new one replaces it: if the download fails, the contact is still found and tried again,
	// and bridgev2 also tries again the next time it sees them (the avatar isn't set).
	ghost.UpdateInfo(ctx, &bridgev2.UserInfo{ExtraUpdates: func(_ context.Context, g *bridgev2.Ghost) bool {
		if g.AvatarMXC != stale {
			return false
		}
		g.AvatarID, g.AvatarHash, g.AvatarSet = "", [32]byte{}, false
		return true
	}})
	// As bridgev2 itself does when it sees a ghost whose avatar isn't set. Some networks
	// (WhatsApp) fetch it in their own background resync instead.
	ghost.UpdateInfoIfNecessary(ctx, login, bridgev2.RemoteEventUnknown)
	return nil
}

// loginSharingChatWith is a logged-in login of someone who shares a chat with the ghost, or nil.
func (c *Connector) loginSharingChatWith(ctx context.Context, ghost networkid.UserID) (*bridgev2.UserLogin, error) {
	rooms, err := c.Store.RoomsOf(ctx, string(ids.GhostMXID(ghost)))
	if err != nil {
		return nil, err
	}
	seen := make(map[networkid.UserLoginID]bool)
	for _, room := range rooms {
		key, ok := ids.ParseRoomID(id.RoomID(room))
		if !ok || key.Receiver == "" || seen[key.Receiver] {
			continue
		}
		seen[key.Receiver] = true
		login := c.Bridge.GetCachedUserLoginByID(key.Receiver)
		if login != nil && login.Client != nil && login.Client.IsLoggedIn() {
			return login, nil
		}
	}
	return nil, nil
}

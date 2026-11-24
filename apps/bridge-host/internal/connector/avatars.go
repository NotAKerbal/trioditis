package connector

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

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
// A contact sent without a copy of their picture (one uploaded before copies were kept) is sent
// it again, or marked for bridgev2 to fetch it again if no copy is left (RunAvatarRepairs).

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
// has none it can use.
func (c *Connector) copyKeptAvatar(ctx context.Context, uri id.ContentURIString, ownerUserID string) *protocol.Attachment {
	kept := c.keptAvatar(ctx, uri)
	if kept == nil {
		return nil
	}
	att, err := c.Media.CopyKept(*kept, ownerUserID)
	if errors.Is(err, media.ErrCorrupt) {
		// Forgotten, so the contact's picture is fetched again (markAvatarStale).
		c.Log.Warn().Msg("An avatar's kept copy is corrupt; it's fetched again")
		if err = c.Store.DeleteKeptAvatar(ctx, string(uri)); err != nil {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Forgetting an avatar's corrupt kept copy failed")
		}
		return nil
	} else if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Copying an avatar's kept copy failed")
		return nil
	}
	return att
}

// keptAvatar is the reference to the bridge host's own copy of an avatar, or nil if it has none
// it can use: none was kept, it was sealed to an earlier bridge key, or its file is gone.
func (c *Connector) keptAvatar(ctx context.Context, uri id.ContentURIString) *protocol.Attachment {
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
	if !c.Media.HasKept(kept) {
		return nil
	}
	return &kept
}

// hasAvatarCopy reports whether the host can still make someone a copy of an avatar.
func (c *Connector) hasAvatarCopy(ctx context.Context, uri id.ContentURIString) bool {
	return c.Media.Available(uri) || c.keptAvatar(ctx, uri) != nil
}

// avatarRepairs is the queue of contacts whose picture is to be fetched again.
type avatarRepairs struct {
	lock   sync.Mutex
	queue  []networkid.UserID
	queued map[networkid.UserID]bool
	wake   chan struct{}
}

func (r *avatarRepairs) init() {
	if r.queued == nil {
		r.queued, r.wake = make(map[networkid.UserID]bool), make(chan struct{}, 1)
	}
}

func (r *avatarRepairs) wakeChan() chan struct{} {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	return r.wake
}

// queueAvatarRepair asks for a contact's picture to be fetched again. It can't be done here:
// this may be called while bridgev2 updates the contact, holding its lock.
func (c *Connector) queueAvatarRepair(ghost networkid.UserID) {
	r := &c.repairs
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	if r.queued[ghost] {
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
	return ghost, true
}

// avatarRepairWorkers is how many contacts are repaired at once: one whose lock a network holds
// while it waits on a request of its own (WhatsApp's resync) doesn't hold the others up.
const avatarRepairWorkers = 4

// RunAvatarRepairs sends contacts their missing pictures until ctx ends. It first queues each
// contact someone was sent without their picture (scanContactAvatars), then repairs each queued
// contact (repairContactAvatar). It never asks a network anything itself, so it never waits on
// one; and a stop doesn't wait for a repair waiting on a contact's lock, which bridgev2 gives no
// way to give up on: that repair ends once the lock is free, or fails once the database is closed.
func (c *Connector) RunAvatarRepairs(ctx context.Context) {
	if err := c.scanContactAvatars(ctx); err != nil && ctx.Err() == nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Looking for contacts sent without their picture failed; it's tried again at the next start")
	}
	wake := c.repairs.wakeChan()
	workers := make(chan struct{}, avatarRepairWorkers)
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
		select {
		case <-ctx.Done():
			return
		case workers <- struct{}{}:
		}
		go func() {
			defer func() { <-workers }()
			if err := c.repairContactAvatar(ctx, ghost); err != nil && ctx.Err() == nil {
				c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Repairing a contact's picture failed; it's tried again at the next start")
			}
		}()
	}
}

// scanContactAvatars queues each contact someone was sent without a copy of their picture
// (before copies were kept, a contact who turned up in someone's chat more than
// media.UploadTTL after their picture was uploaded was sent with none, and nothing sent it again
// unless the picture changed).
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
			if missing, err := c.missingAvatar(ctx, userID, ghost); err != nil {
				failed++
			} else if missing {
				c.queueAvatarRepair(ghost)
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d contacts' pictures couldn't be looked at", failed)
	}
	return nil
}

// missingAvatar reports whether a person was sent a contact without a copy of the picture the
// bridge host has saved for them.
func (c *Connector) missingAvatar(ctx context.Context, userID string, ghost networkid.UserID) (bool, error) {
	dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghost)
	if err != nil || dbGhost == nil || dbGhost.AvatarMXC == "" {
		return false, err
	}
	if _, ours := media.ParseContentURI(dbGhost.AvatarMXC); !ours {
		return false, nil
	}
	if _, err = c.Store.AvatarRef(ctx, userID, string(dbGhost.AvatarMXC)); errors.Is(err, store.ErrNotFound) {
		return true, nil
	}
	return false, err
}

// repairContactAvatar sends a contact's picture to the people who have the contact without it,
// under the contact's lock, which bridgev2 holds while it changes their picture and sends it on:
// so what goes out is the picture they have now, and nothing sent here lands after a newer one.
// If the host has no copy of it left, it marks the contact for bridgev2 to fetch the picture
// again instead (markAvatarStale).
func (c *Connector) repairContactAvatar(ctx context.Context, ghostID networkid.UserID) error {
	ghost, err := c.Bridge.GetExistingGhostByID(ctx, ghostID)
	if err != nil || ghost == nil {
		return err
	}
	ghost.UpdateInfo(ctx, &bridgev2.UserInfo{ExtraUpdates: func(ctx context.Context, g *bridgev2.Ghost) bool {
		uri := g.AvatarMXC
		if _, ours := media.ParseContentURI(uri); !ours {
			return false
		}
		if c.hasAvatarCopy(ctx, uri) {
			err = c.sendAvatarToContactsWithout(ctx, g, uri)
			return false
		}
		return markAvatarStale(g)
	}})
	return err
}

// sendAvatarToContactsWithout sends the contact again, with their picture, to each person who has
// them without it. Called under the contact's lock.
func (c *Connector) sendAvatarToContactsWithout(ctx context.Context, g *bridgev2.Ghost, uri id.ContentURIString) error {
	rooms, err := c.Store.RoomsOf(ctx, string(ids.GhostMXID(g.ID)))
	if err != nil {
		return err
	}
	var name *string
	if g.Name != "" {
		name = &g.Name
	}
	for _, room := range rooms {
		userID, ok := strings.CutPrefix(room, "contacts:")
		if !ok {
			continue
		}
		if _, err = c.Store.AvatarRef(ctx, userID, string(uri)); err == nil {
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		o, err := c.anyOwnerFor(ctx, userID, g.ID)
		if err != nil {
			return err
		} else if o == nil {
			continue
		}
		if err = c.emitContact(ctx, o, g.ID, name, &uri); err != nil {
			return err
		}
	}
	return nil
}

// markAvatarStale makes bridgev2 fetch a contact's picture again, and says whether it changed
// anything. bridgev2 downloads a picture again only once it has forgotten which one it has, and
// refreshes a contact whose avatar isn't set the next time it sees them (a message or a reaction
// from them; WhatsApp in its next background resync), through the login that saw them. So which
// picture it has is forgotten, and saved with the contact; the content URI stays until a new one
// replaces it, so a failed download leaves the contact to be found again. The new upload is kept
// and sent to everyone who has the contact (ghostProfileChanged). Called under the contact's lock.
func markAvatarStale(g *bridgev2.Ghost) bool {
	if g.AvatarID == "" && g.AvatarHash == [32]byte{} && !g.AvatarSet {
		return false
	}
	g.AvatarID, g.AvatarHash, g.AvatarSet = "", [32]byte{}, false
	return true
}

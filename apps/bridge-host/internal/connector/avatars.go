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
// has none it can use. A kept copy found corrupt is forgotten and made again from someone's copy
// (keptAvatar), once.
func (c *Connector) copyKeptAvatar(ctx context.Context, uri id.ContentURIString, ownerUserID string) *protocol.Attachment {
	for range 2 {
		kept, err := c.keptAvatar(ctx, uri)
		if err != nil {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's kept copy failed")
			return nil
		} else if kept == nil {
			return nil
		}
		att, err := c.Media.CopyKept(*kept, ownerUserID)
		if errors.Is(err, media.ErrCorrupt) {
			c.Log.Warn().Msg("An avatar's kept copy is corrupt; it's made again")
			if err = c.Store.DeleteKeptAvatar(ctx, string(uri)); err != nil {
				c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Forgetting an avatar's corrupt kept copy failed")
				return nil
			}
			continue
		} else if err != nil {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Copying an avatar's kept copy failed")
			return nil
		}
		return att
	}
	return nil
}

// keptAvatar is the reference to the bridge host's own copy of an avatar. One that was never kept
// (an avatar from before copies were kept), can't be opened, or whose file is gone, is made again
// from the copy of anyone who was sent the avatar (recoverKeptAvatar). Nil with no error means there's no usable
// copy anywhere; an error, that it couldn't be told for now (a read or a write failed).
func (c *Connector) keptAvatar(ctx context.Context, uri id.ContentURIString) (*protocol.Attachment, error) {
	sealed, err := c.Store.KeptAvatar(ctx, string(uri))
	if errors.Is(err, store.ErrNotFound) {
		return c.recoverKeptAvatar(ctx, uri, false)
	} else if err != nil {
		return nil, err
	}
	var kept protocol.Attachment
	if err = seal.OpenJSON(sealed, c.BridgeKey, keptAvatarContext(uri), &kept); err != nil {
		// Damaged, or sealed to an earlier bridge key: made again from someone's copy if one
		// opens, in its place.
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("An avatar's kept copy couldn't be opened")
		return c.recoverKeptAvatar(ctx, uri, true)
	}
	if has, err := c.Media.HasKept(kept); err != nil {
		// Maybe there, just unreadable for now: the reference stays.
		return nil, err
	} else if !has {
		return c.recoverKeptAvatar(ctx, uri, true)
	}
	return &kept, nil
}

// recoverKeptAvatar makes the bridge host's own copy of an avatar again from a copy someone was
// sent, whose reference the host keeps (sealed to its own key), so a person who meets the contact
// now gets the picture without asking the network for it again. Nil with no error if nobody has a
// copy it can read; an error if one may be readable but reading or keeping it failed.
func (c *Connector) recoverKeptAvatar(ctx context.Context, uri id.ContentURIString, replace bool) (*protocol.Attachment, error) {
	owners, err := c.Store.AvatarRefOwners(ctx, string(uri))
	if err != nil {
		return nil, err
	}
	var failed error
	for _, owner := range owners {
		sealed, err := c.Store.AvatarRef(ctx, owner, string(uri))
		if errors.Is(err, store.ErrNotFound) {
			continue
		} else if err != nil {
			failed = err
			continue
		}
		var ref protocol.Attachment
		if err = seal.OpenJSON(sealed, c.BridgeKey, avatarRefContext(owner, uri), &ref); err != nil {
			continue
		}
		kept, err := c.Media.KeepCopy(ref, owner)
		if errors.Is(err, media.ErrUnavailable) || errors.Is(err, media.ErrCorrupt) {
			continue
		} else if err != nil {
			failed = err
			continue
		}
		var keptSealed *seal.Envelope
		if keptSealed, err = seal.SealJSON(kept, []seal.PublicKey{c.BridgeKey.Public}, keptAvatarContext(uri)); err == nil {
			if replace {
				err = c.Store.ReplaceKeptAvatar(ctx, string(uri), keptSealed)
			} else {
				err = c.Store.PutKeptAvatar(ctx, string(uri), keptSealed)
			}
		}
		if err != nil {
			return nil, err
		}
		return kept, nil
	}
	return nil, failed
}

// hasAvatarCopy reports whether the host can still make someone a copy of an avatar. An error
// means it couldn't be told for now.
func (c *Connector) hasAvatarCopy(ctx context.Context, uri id.ContentURIString) (bool, error) {
	if c.Media.Available(uri) {
		return true, nil
	}
	kept, err := c.keptAvatar(ctx, uri)
	return kept != nil, err
}

// repairState is where a contact is in the repair queue.
type repairState int

const (
	repairQueued       repairState = iota + 1
	repairRunning                  // being repaired
	repairRunningAgain             // being repaired, and asked for again meanwhile
)

// avatarRepairs is the queue of contacts whose picture is to be repaired. A contact is in it, or
// being repaired, at most once: one asked for again while being repaired goes back in once that's
// done, so one contact can't take every worker.
type avatarRepairs struct {
	lock  sync.Mutex
	queue []networkid.UserID
	state map[networkid.UserID]repairState
	wake  chan struct{}
}

func (r *avatarRepairs) init() {
	if r.state == nil {
		r.state, r.wake = make(map[networkid.UserID]repairState), make(chan struct{}, 1)
	}
}

func (r *avatarRepairs) wakeChan() chan struct{} {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	return r.wake
}

// enqueueLocked puts a contact in the queue and wakes the worker. r.lock is held.
func (r *avatarRepairs) enqueueLocked(ghost networkid.UserID) {
	r.state[ghost] = repairQueued
	r.queue = append(r.queue, ghost)
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// queueAvatarRepair asks for a contact's picture to be repaired. It can't be done here: this may
// be called while bridgev2 updates the contact, holding its lock.
func (c *Connector) queueAvatarRepair(ghost networkid.UserID) {
	r := &c.repairs
	r.lock.Lock()
	defer r.lock.Unlock()
	r.init()
	switch r.state[ghost] {
	case 0:
		r.enqueueLocked(ghost)
	case repairRunning:
		r.state[ghost] = repairRunningAgain
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
	r.state[ghost] = repairRunning
	return ghost, true
}

// avatarRepairDone ends a contact's repair, and queues it again if it was asked for meanwhile.
func (c *Connector) avatarRepairDone(ghost networkid.UserID) {
	r := &c.repairs
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.state[ghost] == repairRunningAgain {
		r.enqueueLocked(ghost)
	} else {
		delete(r.state, ghost)
	}
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
			defer c.avatarRepairDone(ghost)
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
	sent, err := c.Store.AvatarSent(ctx, userID, string(ids.GhostMXID(ghost)), string(dbGhost.AvatarMXC))
	return !sent && err == nil, err
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
		has, hasErr := c.hasAvatarCopy(ctx, uri)
		if hasErr != nil {
			// Only a picture nobody has a copy of is fetched again: a network that won't show it
			// to the login that sees the contact next (WhatsApp) would take it away from everyone.
			err = hasErr
			return false
		} else if has {
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
		if sent, err := c.Store.AvatarSent(ctx, userID, string(ids.GhostMXID(g.ID)), string(uri)); err != nil {
			return err
		} else if sent {
			continue
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

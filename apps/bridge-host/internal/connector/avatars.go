package connector

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
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
//   - for each person, the reference to their copy (avatarRef), so a later change to a name
//     alone carries the picture they already have.

const (
	// avatarKind is what a kept reference to a person's avatar copy is sealed as.
	avatarKind seal.Kind = "avatarRef"
	// avatarKeptKind is what the reference to the bridge host's own copy is sealed as.
	avatarKeptKind seal.Kind = "avatarKept"
)

func keptAvatarContext(uri id.ContentURIString) seal.Context {
	return seal.Context{Kind: avatarKeptKind, OwnerUserID: media.KeptOwner, ObjectID: string(uri)}
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
// made from the upload while it lives, then the copy they already have, or else a new one made
// from the bridge host's own copy. Nil when there is none of these.
func (c *Connector) avatarFor(ctx context.Context, uri id.ContentURIString, ownerUserID string) *protocol.Attachment {
	sealCtx := seal.Context{Kind: avatarKind, OwnerUserID: ownerUserID, ObjectID: string(uri)}
	att, err := c.Media.AttachmentFor(uri, ownerUserID)
	if err == nil {
		c.keepAvatar(ctx, uri)
		c.putAvatarRef(ctx, sealCtx, att)
		return att
	}
	kept, err := c.Store.AvatarRef(ctx, ownerUserID, string(uri))
	if err == nil {
		var ref protocol.Attachment
		if err = seal.OpenJSON(kept, c.BridgeKey, sealCtx, &ref); err == nil {
			return &ref
		}
		// Sealed to an earlier bridge key, say: the avatar is left as the client has it.
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("An avatar's reference couldn't be opened")
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Reading an avatar's reference failed")
		return nil
	}
	if att = c.copyKeptAvatar(ctx, uri, ownerUserID); att != nil {
		c.putAvatarRef(ctx, sealCtx, att)
	}
	return att
}

// putAvatarRef keeps the reference to a person's copy of an avatar. On failure the avatar still
// goes now; only a later resend of this copy is lost.
func (c *Connector) putAvatarRef(ctx context.Context, sealCtx seal.Context, att *protocol.Attachment) {
	kept, err := seal.SealJSON(att, []seal.PublicKey{c.BridgeKey.Public}, sealCtx)
	if err == nil {
		err = c.Store.PutAvatarRef(ctx, sealCtx.OwnerUserID, sealCtx.ObjectID, kept)
	}
	if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Keeping an avatar's reference failed")
	}
}

// copyKeptAvatar makes the owner a copy of an avatar from the bridge host's own, or nil if it
// has none.
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

// RepairContactAvatars sends, once per database, the pictures of contacts whose profile went
// out without one. Before the bridge host kept its own copy of each avatar, a contact who turned
// up in someone's chat more than media.UploadTTL after their picture was uploaded (most of them,
// after a network's first sync) was sent with no picture, and nothing sent it again unless the
// picture changed. Each such contact's picture is fetched from the network again, which sends it
// to everyone who has the contact. A failure leaves the pass to be tried again at the next start;
// a contact already repaired then has the picture, and is left alone.
func (c *Connector) RepairContactAvatars(ctx context.Context) error {
	if done, err := c.Store.RepairedContactAvatars(ctx); err != nil || done {
		return err
	}
	rooms, err := c.Store.ContactRooms(ctx)
	if err != nil {
		return err
	}
	// Each contact sent without their picture, and the people it was sent to.
	missing := map[networkid.UserID][]string{}
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
			ghost, ok := ids.ParseGhostMXID(id.UserID(mxid))
			if !ok {
				continue
			}
			dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghost)
			if err != nil {
				return err
			} else if dbGhost == nil || dbGhost.AvatarMXC == "" {
				continue
			}
			// Someone who has a copy was sent the picture.
			if _, err = c.Store.AvatarRef(ctx, userID, string(dbGhost.AvatarMXC)); err == nil {
				continue
			} else if !errors.Is(err, store.ErrNotFound) {
				return err
			}
			missing[ghost] = append(missing[ghost], userID)
		}
	}
	pace := c.AvatarRepairPace
	if pace == 0 {
		pace = time.Second
	}
	failed := 0
	for i, ghost := range slices.Sorted(maps.Keys(missing)) {
		if i > 0 {
			// The network is asked for each picture in turn, so a long list doesn't run into its
			// rate limits.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(pace):
			}
		}
		if err = c.repairContactAvatar(ctx, ghost, missing[ghost]); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d contacts' pictures couldn't be sent again", failed)
	}
	return c.Store.SetRepairedContactAvatars(ctx)
}

// repairContactAvatar sends a contact's picture to the people (userIDs) who were sent the contact
// without it.
func (c *Connector) repairContactAvatar(ctx context.Context, ghostID networkid.UserID, userIDs []string) error {
	dbGhost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghostID)
	if err != nil || dbGhost == nil || dbGhost.AvatarMXC == "" {
		return err
	}
	// The host has its copy already (a pass cut short after this contact's was made): each
	// person's copy is made from it.
	if _, err = c.Store.KeptAvatar(ctx, string(dbGhost.AvatarMXC)); err == nil {
		for _, userID := range userIDs {
			o, err := c.anyOwnerFor(ctx, userID, ghostID)
			if err != nil {
				return err
			} else if o == nil {
				continue
			}
			if err = c.emitContact(ctx, o, ghostID, nil, nil); err != nil {
				return err
			}
		}
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	// Otherwise the picture is fetched again, through a login of someone who has the contact and
	// still shares a chat with them.
	var login *bridgev2.UserLogin
	for _, userID := range userIDs {
		o, err := c.anyOwnerFor(ctx, userID, ghostID)
		if err != nil {
			return err
		} else if o == nil {
			continue
		}
		if l := c.Bridge.GetCachedUserLoginByID(o.login); l != nil && l.Client != nil {
			login = l
			break
		}
	}
	if login == nil {
		return nil
	}
	ghost, err := c.Bridge.GetGhostByID(ctx, ghostID)
	if err != nil {
		return err
	}
	info, err := login.Client.GetUserInfo(ctx, ghost)
	if err != nil {
		return err
	} else if info == nil || info.Avatar == nil {
		// The network says nothing of a picture now.
		return nil
	}
	if !info.Avatar.Remove {
		// Forgetting the upload that's gone makes bridgev2 download the picture again, rather
		// than keep the content URI it has for the same picture. Setting it sends it to everyone
		// who has the contact (ghostProfileChanged).
		ghost.AvatarMXC, ghost.AvatarHash, ghost.AvatarSet = "", [32]byte{}, false
	}
	ghost.UpdateInfo(ctx, info)
	if !info.Avatar.Remove && (ghost.AvatarMXC == "" || !ghost.AvatarSet) {
		// bridgev2 couldn't download it, or it couldn't be sent. bridgev2 tries again the next
		// time the contact is seen, and so does the next start's pass.
		return errors.New("the contact's picture couldn't be sent again")
	}
	return nil
}

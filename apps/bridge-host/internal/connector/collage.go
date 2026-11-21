package connector

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
)

// A group with no picture of its own is shown by a collage of its members' pictures. The
// bridge host says which members, in the chat's sealed metadata (ChatPlaintext.Collage); the
// clients draw each from that contact's own profile, so a member's new picture shows without
// the chat being described again.

// collageSize is the most members a collage shows.
const collageSize = 4

// collageScan is the most of a group's members looked at to choose its collage, so a very big
// group costs no more than a big one. Members are looked at in a fixed order (their ghost ID),
// so the same members keep being chosen.
const collageScan = 256

// collagesDescribedMark records that the chats bridged before collages existed have been
// described again with theirs.
const collagesDescribedMark = "collages-described"

// collageGhosts chooses the members a chat's collage shows (chooseCollage).
func (c *Connector) collageGhosts(ctx context.Context, o *owner) ([]networkid.UserID, error) {
	members, err := c.Store.Members(ctx, string(o.roomID))
	if err != nil {
		return nil, err
	}
	ghosts := make([]networkid.UserID, 0, len(members))
	for _, member := range members {
		if ghost, ok := ids.ParseGhostMXID(id.UserID(member)); ok {
			ghosts = append(ghosts, ghost)
		}
	}
	login := c.Bridge.GetCachedUserLoginByID(o.login)
	isSelf := func(ghostID networkid.UserID) bool {
		return ghostID == networkid.UserID(o.login) || login != nil && login.Client != nil && login.Client.IsThisUser(ctx, ghostID)
	}
	hasPicture := func(ghostID networkid.UserID) (bool, error) {
		// From bridgev2's cache: a picture being set is there before it is saved.
		ghost, err := c.Bridge.GetExistingGhostByID(ctx, ghostID)
		return ghost != nil && ghost.AvatarMXC != "", err
	}
	return chooseCollage(ghosts, isSelf, hasPicture)
}

// chooseCollage chooses up to collageSize of a chat's members (by ghost ID), never the person
// themselves, those with a picture first, each kind in ghost ID order. Only the first collageScan
// members in that order are looked at.
func chooseCollage(ghosts []networkid.UserID, isSelf func(networkid.UserID) bool, hasPicture func(networkid.UserID) (bool, error)) ([]networkid.UserID, error) {
	ghosts = slices.Clone(ghosts)
	slices.Sort(ghosts)
	ghosts = slices.Compact(ghosts)
	var pictured, plain []networkid.UserID
	for _, ghostID := range ghosts[:min(len(ghosts), collageScan)] {
		if len(pictured) == collageSize {
			break
		}
		if isSelf(ghostID) {
			continue
		}
		pictureSet, err := hasPicture(ghostID)
		if err != nil {
			return nil, err
		}
		if pictureSet {
			pictured = append(pictured, ghostID)
		} else if len(plain) < collageSize {
			plain = append(plain, ghostID)
		}
	}
	chosen := append(pictured, plain...)
	return chosen[:min(len(chosen), collageSize)], nil
}

// collage is the chat's collage as clients take it: the chosen members' opaque ghost IDs, the
// IDs their contacts are under.
func (c *Connector) collage(ctx context.Context, o *owner) ([]string, error) {
	ghosts, err := c.collageGhosts(ctx, o)
	if err != nil || len(ghosts) == 0 {
		return nil, err
	}
	out := make([]string, 0, len(ghosts))
	for _, ghost := range ghosts {
		ghostID, err := c.ghostOpaque(ctx, ghost)
		if err != nil {
			return nil, err
		}
		out = append(out, ghostID)
	}
	return out, nil
}

// inCollage reports whether a group with no picture of its own shows ghost in its collage. A
// chat that has a picture, a direct chat, or one that can't be looked up shows no collage.
func (c *Connector) inCollage(ctx context.Context, roomID id.RoomID, ghost networkid.UserID) bool {
	portal, err := c.Bridge.DB.Portal.GetByMXID(ctx, roomID)
	if err != nil || portal == nil || portal.RoomType == database.RoomTypeDM || portal.AvatarMXC != "" {
		return false
	}
	o, err := c.owner(ctx, roomID)
	if err != nil {
		return false
	}
	ghosts, err := c.collageGhosts(ctx, o)
	if err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Choosing a chat's collage failed")
		return false
	}
	return slices.Contains(ghosts, ghost)
}

// pictureChanged describes again the chats, among rooms, whose collage now shows the ghost
// whose picture changed: one that has just got a picture can take the place of a member
// without one. A failure leaves that chat's collage as it was.
func (c *Connector) pictureChanged(ctx context.Context, ghost networkid.UserID, rooms []string) {
	for _, room := range rooms {
		if strings.HasPrefix(room, "contacts:") || strings.HasPrefix(room, "numbers:") {
			continue
		}
		if !c.inCollage(ctx, id.RoomID(room), ghost) {
			continue
		}
		if err := c.emitChat(ctx, id.RoomID(room), chatOverride{}); err != nil && !errors.Is(err, errNotPortal) {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Describing a chat for its collage failed")
		}
	}
}

// DescribeForCollages describes again, once per database, every group with no picture of its
// own, so chats bridged before collages existed get theirs. A pass cut short (by a stop or a
// failure) runs again at the next start; describing a chat twice is harmless.
func (c *Connector) DescribeForCollages(ctx context.Context) error {
	done, err := c.Store.Marked(ctx, collagesDescribedMark)
	if err != nil || done {
		return err
	}
	portals, err := c.Bridge.DB.Portal.GetAllWithMXID(ctx)
	if err != nil {
		return err
	}
	failed := 0
	for _, portal := range portals {
		if err = ctx.Err(); err != nil {
			return err
		}
		if portal.RoomType == database.RoomTypeDM || portal.AvatarMXC != "" || portal.Receiver == "" {
			continue
		}
		// A chat whose login is gone has nobody to describe it to.
		if login, err := c.Bridge.DB.UserLogin.GetByID(ctx, portal.Receiver); err != nil {
			return err
		} else if login == nil {
			continue
		}
		if err = c.emitChat(ctx, portal.MXID, chatOverride{}); err != nil && !errors.Is(err, errNotPortal) {
			c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Describing a chat for its collage failed")
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d chats couldn't be described for their collage", failed)
	}
	return c.Store.Mark(ctx, collagesDescribedMark)
}

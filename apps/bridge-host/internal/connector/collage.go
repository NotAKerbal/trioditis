package connector

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// A group with no picture of its own is shown by a collage of its members' pictures. The
// bridge host says which members in a chatCollage event of its own, never in the chat's
// metadata: bridgev2 changes a chat's name, picture and members in one go and saves the chat
// only after, so describing the chat again for its collage could send a name or picture that is
// being replaced. Clients draw each member from that contact's profile, so a member's new picture
// shows without a new collage. A collage is sent only when the choice changes (trioditis_collage).

// collageSize is the most members a collage shows.
const collageSize = 4

// collageScan is the most of a group's members looked at to choose its collage, so a very big
// group costs no more than a big one. Members are looked at in a fixed order (their ghost ID),
// so the same members keep being chosen.
const collageScan = 256

// collageChange is what is known about a chat beyond what's saved, when its collage is chosen
// again.
type collageChange struct {
	// group says the chat is a group, for one bridgev2 hasn't saved yet.
	group bool
	// ghost's picture has just been set (pictured) or removed, and may not be saved yet.
	ghost    networkid.UserID
	pictured bool
}

// refreshCollage chooses a chat's collage again and sends it if it changed. A direct chat's is
// empty. A room that isn't a known portal has none.
func (c *Connector) refreshCollage(ctx context.Context, roomID id.RoomID, change collageChange) error {
	lock, _ := c.collageLocks.LoadOrStore(roomID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()

	o, err := c.owner(ctx, roomID)
	if errors.Is(err, errNotPortal) {
		return nil
	} else if err != nil {
		return err
	}
	group := change.group
	if !group {
		portal, err := c.Bridge.DB.Portal.GetByMXID(ctx, roomID)
		if err != nil {
			return err
		} else if portal == nil {
			// Not created yet: CreateRoom chooses it once the chat is.
			return nil
		}
		group = portal.RoomType != database.RoomTypeDM
	}
	var ghosts []string
	if group {
		if ghosts, err = c.collage(ctx, o, change); err != nil {
			return err
		}
	}
	chosen := strings.Join(ghosts, ",")
	last, sent, err := c.Store.Collage(ctx, string(roomID))
	if err != nil {
		return err
	}
	if last == chosen && (sent || chosen == "") {
		return nil
	}
	if chosen != "" || sent {
		// Sealed to the person only: agents given the chat have no need of its members.
		person := *o
		person.portalID = ""
		sealed, err := c.seal(ctx, &person, seal.KindChat, o.portalID+"/collage", protocol.ChatCollagePlaintext{Ghosts: nonNil(ghosts)})
		if err != nil {
			return err
		}
		if err = c.emit(ctx, &protocol.Event{
			Type: protocol.EventChatCollage, UserID: o.userID, LoginID: o.loginID, PortalID: o.portalID, Sealed: sealed,
		}); err != nil {
			return err
		}
	}
	// Recorded after it's sent: a stop in between sends it again, which is harmless.
	return c.Store.SetCollage(ctx, string(roomID), chosen)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// refreshCollageOrLog is refreshCollage for callers whose own work must not fail for it; the
// collage is chosen again with the chat's next change, or at the next start.
func (c *Connector) refreshCollageOrLog(ctx context.Context, roomID id.RoomID, change collageChange) {
	if err := c.refreshCollage(ctx, roomID, change); err != nil {
		c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Choosing a chat's collage failed")
	}
}

// collage is the chat's collage as clients take it: the chosen members' opaque ghost IDs, the
// IDs their contacts are under.
func (c *Connector) collage(ctx context.Context, o *owner, change collageChange) ([]string, error) {
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
		if change.ghost != "" && ghostID == change.ghost {
			return change.pictured, nil
		}
		// As saved: another goroutine may be changing the cached ghost.
		ghost, err := c.Bridge.DB.Ghost.GetByID(ctx, ghostID)
		return ghost != nil && ghost.AvatarMXC != "", err
	}
	chosen, err := chooseCollage(ghosts, isSelf, hasPicture)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(chosen))
	for _, ghost := range chosen {
		ghostID, err := c.ghostOpaque(ctx, ghost)
		if err != nil {
			return nil, err
		}
		out = append(out, ghostID)
	}
	return out, nil
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

// pictureChanged chooses again the collages of the chats, among rooms, that the ghost whose
// picture changed is in: one who got a picture can take the place of a member without one, and
// one who lost theirs can give way.
func (c *Connector) pictureChanged(ctx context.Context, ghost networkid.UserID, pictured bool, rooms []string) {
	for _, room := range rooms {
		if strings.HasPrefix(room, "contacts:") || strings.HasPrefix(room, "numbers:") {
			continue
		}
		c.refreshCollageOrLog(ctx, id.RoomID(room), collageChange{ghost: ghost, pictured: pictured})
	}
}

// RefreshCollages chooses every chat's collage again, at each start: chats bridged before
// collages existed get theirs, and one whose choice failed before is tried again. Only those
// that changed are sent.
func (c *Connector) RefreshCollages(ctx context.Context) error {
	portals, err := c.Bridge.DB.Portal.GetAllWithMXID(ctx)
	if err != nil {
		return err
	}
	failed := 0
	for _, portal := range portals {
		if err = ctx.Err(); err != nil {
			return err
		}
		if portal.Receiver == "" {
			continue
		}
		// A chat whose login is gone has nobody to send it to.
		if login, err := c.Bridge.DB.UserLogin.GetByID(ctx, portal.Receiver); err != nil {
			return err
		} else if login == nil {
			continue
		}
		if err = c.refreshCollage(ctx, portal.MXID, collageChange{}); err != nil {
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d chats' collages couldn't be chosen", failed)
	}
	return nil
}

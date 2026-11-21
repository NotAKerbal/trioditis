package host

import (
	"context"
	"slices"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/testconnector"
)

// crowdGhosts finds the opaque ghost IDs of a crowd chat's members, from their contacts.
func crowdGhosts(t *testing.T, h *harness, chat networkid.PortalID) map[networkid.UserID]string {
	t.Helper()
	out := make(map[networkid.UserID]string)
	for n := 1; n <= testconnector.CrowdSize; n++ {
		member := testconnector.CrowdMember(chat, n)
		contact := h.gw.waitFor(t, "a crowd member's contact", func(e *protocol.Event) bool {
			if e.Type != protocol.EventContact || e.UserID != "alice" {
				return false
			}
			var plain protocol.ContactPlaintext
			h.open("alice", e, &plain)
			return plain.Name == testconnector.DisplayName(member)
		})
		out[member] = contact.GhostID
	}
	return out
}

// collageOf waits for a chat event for portalID that satisfies match, and returns its collage.
func collageOf(t *testing.T, h *harness, what, portalID string, match func([]string) bool) []string {
	t.Helper()
	var got []string
	h.gw.waitFor(t, what, func(e *protocol.Event) bool {
		if e.Type != protocol.EventChat || e.PortalID != portalID {
			return false
		}
		var plain protocol.ChatPlaintext
		h.open("alice", e, &plain)
		got = plain.Collage
		return match(got)
	})
	return got
}

// A group with no picture says which members its collage shows: four, never the person, and
// one who gets a picture takes the place of one who has none.
func TestAGroupWithNoPictureShowsACollageOfItsMembers(t *testing.T) {
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw)
	defer h.host.Stop()
	h.login("alice", "alice-testnet")
	const chat = networkid.PortalID("crowd-a")
	if err := h.net.Incoming("alice-testnet", chat, testconnector.CrowdMember(chat, 1), "c1", "hello crowd", time.Now()); err != nil {
		t.Fatal(err)
	}
	portalID := gw.waitFor(t, "the crowd's message", isMessage("hello crowd", h, "alice")).PortalID
	ghosts := crowdGhosts(t, h, chat)
	member := func(n int) string { return ghosts[testconnector.CrowdMember(chat, n)] }

	first := []string{member(1), member(2), member(3), member(4)}
	collageOf(t, h, "the crowd's collage", portalID, func(c []string) bool { return slices.Equal(c, first) })

	if err := h.net.SetPicture(context.Background(), testconnector.CrowdMember(chat, 5), []byte("a picture")); err != nil {
		t.Fatal(err)
	}
	pictured := []string{member(5), member(1), member(2), member(3)}
	collageOf(t, h, "the collage with the pictured member", portalID, func(c []string) bool { return slices.Equal(c, pictured) })
}

// Groups bridged before collages existed are described again once, with theirs.
func TestGroupsFromBeforeCollagesAreDescribedAgain(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	_, portalID := setUpChat(t, h, "old-group", "hello from before")
	h.host.Stop()
	isChat := func(e *protocol.Event) bool { return e.Type == protocol.EventChat && e.PortalID == portalID }
	ctx := context.Background()

	// Once the pass is done, a start describes nothing again.
	before := gw.count(isChat)
	control := startHost(t, dir, gw)
	for !func() bool { done, _ := control.host.Store.Marked(ctx, "collages-described"); return done }() {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(time.Second)
	control.host.Stop()
	if gw.count(isChat) != before {
		t.Fatal("a start after the pass described the group again")
	}

	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	// As a database from before collages: its pass never ran.
	if _, err := h2.host.DB.Exec(ctx, `DELETE FROM trioditis_secret WHERE name='done:collages-described'`); err != nil {
		t.Fatal(err)
	}
	before = gw.count(isChat)
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	deadline := time.Now().Add(10 * time.Second)
	for gw.count(isChat) == before {
		if time.Now().After(deadline) {
			t.Fatal("the old group wasn't described again")
		}
		time.Sleep(20 * time.Millisecond)
	}
	collageOf(t, h2, "the old group's collage", portalID, func(c []string) bool { return len(c) == 1 })
	for !func() bool { done, _ := h2.host.Store.Marked(ctx, "collages-described"); return done }() {
		if time.Now().After(deadline) {
			t.Fatal("the pass wasn't recorded as done")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

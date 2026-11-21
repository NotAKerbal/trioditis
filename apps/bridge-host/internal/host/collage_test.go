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
func crowdGhosts(t *testing.T, h *harness, chat networkid.PortalID) map[int]string {
	t.Helper()
	out := make(map[int]string)
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
		out[n] = contact.GhostID
	}
	return out
}

func isCollage(portalID string) func(*protocol.Event) bool {
	return func(e *protocol.Event) bool { return e.Type == protocol.EventChatCollage && e.PortalID == portalID }
}

func isChat(portalID string) func(*protocol.Event) bool {
	return func(e *protocol.Event) bool { return e.Type == protocol.EventChat && e.PortalID == portalID }
}

// lastCollage waits until the newest collage event for portalID is want.
func lastCollage(t *testing.T, h *harness, what, portalID string, want []string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var got []string
	for time.Now().Before(deadline) {
		got = nil
		for _, e := range h.gw.snapshot() {
			if isCollage(portalID)(e) {
				var plain protocol.ChatCollagePlaintext
				h.open("alice", e, &plain)
				got = plain.Ghosts
			}
		}
		if got != nil && slices.Equal(got, want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s: collage %q, want %q", what, got, want)
}

// A group's collage is four members, never the person; one who gets a picture takes the place of
// one who has none, and gives it back when it goes. Choosing again never describes the chat.
func TestAGroupsCollageFollowsItsMembersPictures(t *testing.T) {
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw)
	defer h.host.Stop()
	h.login("alice", "alice-testnet")
	const chat = networkid.PortalID("crowd-a")
	if err := h.net.Incoming("alice-testnet", chat, testconnector.CrowdMember(chat, 1), "c1", "hello crowd", time.Now()); err != nil {
		t.Fatal(err)
	}
	portalID := gw.waitFor(t, "the crowd's message", isMessage("hello crowd", h, "alice")).PortalID
	m := crowdGhosts(t, h, chat)
	ctx := context.Background()

	first := []string{m[1], m[2], m[3], m[4]}
	lastCollage(t, h, "the first collage", portalID, first)
	chats := gw.count(isChat(portalID))

	if err := h.net.SetPicture(ctx, testconnector.CrowdMember(chat, 5), []byte("a picture")); err != nil {
		t.Fatal(err)
	}
	lastCollage(t, h, "with the pictured member", portalID, []string{m[5], m[1], m[2], m[3]})
	collages := gw.count(isCollage(portalID))

	// A new picture for a member already shown changes only their contact.
	if err := h.net.SetPicture(ctx, testconnector.CrowdMember(chat, 5), []byte("another picture")); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's new picture", func(e *protocol.Event) bool {
		if e.Type != protocol.EventContact || e.GhostID != m[5] {
			return false
		}
		var plain protocol.ContactPlaintext
		h.open("alice", e, &plain)
		return plain.Avatar != nil
	})
	if n := gw.count(isCollage(portalID)); n != collages {
		t.Fatalf("an unchanged collage was sent again (%d, was %d)", n, collages)
	}

	if err := h.net.SetPicture(ctx, testconnector.CrowdMember(chat, 5), nil); err != nil {
		t.Fatal(err)
	}
	lastCollage(t, h, "once the picture is gone", portalID, first)
	if n := gw.count(isChat(portalID)); n != chats {
		t.Fatalf("choosing the collage described the chat again (%d chat events, was %d)", n, chats)
	}
}

// Chats from before collages get theirs at the next start; a start with nothing changed sends none.
func TestCollagesAreChosenAgainAtStart(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	_, portalID := setUpChat(t, h, "old-group", "hello from before")
	gw.waitFor(t, "the group's collage", isCollage(portalID))
	h.host.Stop()
	ctx := context.Background()

	before := gw.count(isCollage(portalID))
	control := startHost(t, dir, gw)
	time.Sleep(1500 * time.Millisecond)
	control.host.Stop()
	if n := gw.count(isCollage(portalID)); n != before {
		t.Fatalf("an unchanged collage was sent again at start (%d, was %d)", n, before)
	}

	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	// As a database from before collages.
	if _, err := h2.host.DB.Exec(ctx, `DELETE FROM trioditis_collage`); err != nil {
		t.Fatal(err)
	}
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	deadline := time.Now().Add(10 * time.Second)
	for gw.count(isCollage(portalID)) == before {
		if time.Now().After(deadline) {
			t.Fatal("the old group's collage wasn't sent")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

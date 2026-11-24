package host

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/testconnector"
)

// isContactOf matches alice's contact events for a member, by the name the test network gives.
func isContactOf(h *harness, member networkid.UserID) func(*protocol.Event) bool {
	return func(e *protocol.Event) bool {
		if e.Type != protocol.EventContact || e.UserID != "alice" {
			return false
		}
		var plain protocol.ContactPlaintext
		h.open("alice", e, &plain)
		return plain.Name == testconnector.DisplayName(member)
	}
}

// pictureOf is the picture a contact event carries, fetched and decrypted as alice's client
// would, or nil if it carries none.
func pictureOf(t *testing.T, h *harness, e *protocol.Event) []byte {
	t.Helper()
	var plain protocol.ContactPlaintext
	h.open("alice", e, &plain)
	if plain.Avatar == nil {
		return nil
	}
	status, ct := h.media(plain.Avatar.MediaID, "alice")
	if status != http.StatusOK {
		t.Fatalf("fetching the picture returned %d", status)
	}
	data, err := seal.DecryptMedia(ct, plain.Avatar.Key, plain.Avatar.Nonce, "alice", plain.Avatar.MediaID)
	if err != nil {
		t.Fatalf("the picture didn't open for alice: %v", err)
	}
	return data
}

// A network's first sync uploads every contact's picture before they're in anyone's chat, and
// history can take hours to arrive: a contact who turns up long after (here, after a restart,
// which loses every upload) still comes with their picture.
func TestAContactMetAfterTheirPictureWasUploadedComesWithIt(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-late")
	member := testconnector.CrowdMember(chat, 1)
	picture := []byte("a picture from the first sync")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	h.host.Stop()

	h2 := startHost(t, dir, gw)
	defer h2.host.Stop()
	if err := h2.net.Incoming("alice-testnet", chat, member, "late-1", "hello at last", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello at last", h2, "alice"))
	contact := gw.waitFor(t, "the member's contact", isContactOf(h2, member))
	if got := pictureOf(t, h2, contact); !bytes.Equal(got, picture) {
		t.Fatalf("the contact came with picture %q, want %q", got, picture)
	}
}

// A database from before the bridge host kept its own copies has contacts that went out without
// their picture. Once, each such contact's picture is fetched from the network again and sent.
func TestContactsSentWithoutTheirPictureAreSentItOnce(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-old")
	member := testconnector.CrowdMember(chat, 1)
	picture := []byte("a picture nobody was sent")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	h.host.Stop()

	// As a database from before: no kept copies.
	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.host.DB.Exec(ctx, `DELETE FROM trioditis_avatar_kept`); err != nil {
		t.Fatal(err)
	}
	h2.net.KnowPicture(member, picture)
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	<-h2.host.postStart
	if err := h2.net.Incoming("alice-testnet", chat, member, "old-1", "hello from before", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello from before", h2, "alice"))
	without := gw.waitFor(t, "the member's contact", isContactOf(h2, member))
	if got := pictureOf(t, h2, without); got != nil {
		t.Fatalf("the contact came with a picture, %q, though none could be sent then", got)
	}

	// The next start's pass, as on a database that hasn't had it.
	if _, err := h2.host.DB.Exec(ctx, `DELETE FROM trioditis_secret WHERE name='repaired_contact_avatars'`); err != nil {
		t.Fatal(err)
	}
	h2.host.Connector.AvatarRepairPace = time.Millisecond
	if err := h2.host.Connector.RepairContactAvatars(ctx); err != nil {
		t.Fatal(err)
	}
	isMember := isContactOf(h2, member)
	repaired := gw.waitFor(t, "the member's contact with their picture", func(e *protocol.Event) bool {
		return isMember(e) && e.Seq > without.Seq
	})
	if got := pictureOf(t, h2, repaired); !bytes.Equal(got, picture) {
		t.Fatalf("the contact was sent again with picture %q, want %q", got, picture)
	}
	if done, err := h2.host.Store.RepairedContactAvatars(ctx); err != nil || !done {
		t.Fatalf("not marked done: %v %v", done, err)
	}
	// Once is enough: the next start sends nothing again.
	before := gw.count(isMember)
	if err := h2.host.Connector.RepairContactAvatars(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := gw.count(isMember); n != before {
		t.Fatalf("the contact was sent again (%d events, was %d)", n, before)
	}
}

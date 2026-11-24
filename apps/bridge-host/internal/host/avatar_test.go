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

// lastSeq is the newest event's sequence number so far.
func (g *fakeGateway) lastSeq() int64 {
	var seq int64
	for _, e := range g.snapshot() {
		seq = max(seq, e.Seq)
	}
	return seq
}

// lastContact is the newest of alice's contact events for a member after seq, or nil.
func lastContact(h *harness, member networkid.UserID, after int64) *protocol.Event {
	var last *protocol.Event
	for _, e := range h.gw.snapshot() {
		if e.Seq > after && isContactOf(h, member)(e) {
			last = e
		}
	}
	return last
}

// waitForPicture waits until a contact event for member after seq carries want.
func waitForPicture(t *testing.T, h *harness, member networkid.UserID, after int64, want []byte) *protocol.Event {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if e := lastContact(h, member, after); e != nil && bytes.Equal(pictureOf(t, h, e), want) {
			return e
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no contact for %s after %d came with the picture", member, after)
	return nil
}

// oldHost starts a host over dir as one from before kept copies: none of the pictures uploaded
// so far has one. The network knows the member's picture, as a real one does after a restart.
func oldHost(t *testing.T, dir string, gw *fakeGateway, member networkid.UserID, picture []byte) *harness {
	t.Helper()
	ctx := context.Background()
	h := buildHost(t, dir, gw)
	if err := h.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h.host.DB.Exec(ctx, `DELETE FROM trioditis_avatar_kept`); err != nil {
		t.Fatal(err)
	}
	h.net.KnowPicture(member, picture)
	if err := h.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return h
}

// ghostAvatar is a member's saved avatar: its content URI, and whether bridgev2 has it set.
func ghostAvatar(t *testing.T, h *harness, member networkid.UserID) (mxc string, set bool) {
	t.Helper()
	if err := h.host.DB.QueryRow(context.Background(), `SELECT avatar_mxc, avatar_set FROM ghost WHERE id=$1`, string(member)).Scan(&mxc, &set); err != nil {
		t.Fatal(err)
	}
	return mxc, set
}

// waitMarked waits until a member's picture is marked to be fetched again, still naming the
// saved picture, or has been fetched again already (bridgev2 may see them again meanwhile).
func waitMarked(t *testing.T, h *harness, member networkid.UserID, stale string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		mxc, set := ghostAvatar(t, h, member)
		if mxc != stale || !set {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the picture wasn't marked to be fetched again")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A contact whose picture was uploaded before the bridge host kept copies, first met afterwards,
// is sent at once without it, and with it once fetched again: the next time they're seen.
func TestAContactWithNoCopyOfTheirPictureLeftIsSentItOnceFetchedAgain(t *testing.T) {
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

	h2 := oldHost(t, dir, gw, member, picture)
	defer h2.host.Stop()
	stale, _ := ghostAvatar(t, h2, member)
	if err := h2.net.Incoming("alice-testnet", chat, member, "old-1", "hello from before", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello from before", h2, "alice"))
	first := gw.waitFor(t, "the member's contact", isContactOf(h2, member))
	if got := pictureOf(t, h2, first); got != nil {
		t.Fatalf("the contact came with a picture, %q, though none could be sent then", got)
	}
	waitMarked(t, h2, member, stale)
	if err := h2.net.Incoming("alice-testnet", chat, member, "old-2", "hello again", time.Now()); err != nil {
		t.Fatal(err)
	}
	waitForPicture(t, h2, member, first.Seq, picture)
}

// At start, a person who was sent a contact without their picture (a database from before kept
// copies) is sent it once it's fetched again, the next time the contact is seen. A failed
// download leaves the contact to be tried again, and sends nothing wrong meanwhile.
func TestContactsSentWithoutTheirPictureAreSentItWhenNextSeen(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-start")
	member := testconnector.CrowdMember(chat, 1)
	picture := []byte("a picture sent at the next start")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	if err := h.net.Incoming("alice-testnet", chat, member, "s-1", "hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello", h, "alice"))
	gw.waitFor(t, "the member's contact", isContactOf(h, member))
	h.host.Stop()

	// As if alice had been sent the contact without it: no copy of hers, nor the host's. The
	// network's media server fails at first.
	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"trioditis_avatar_kept", "trioditis_avatar_ref"} {
		if _, err := h2.host.DB.Exec(ctx, `DELETE FROM `+table); err != nil {
			t.Fatal(err)
		}
	}
	stale, _ := ghostAvatar(t, h2, member)
	if stale == "" {
		t.Fatal("the member has no picture saved")
	}
	h2.net.KnowPicture(member, picture)
	h2.net.BreakPictures(true)
	before := gw.lastSeq()
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitMarked(t, h2, member, stale)
	if err := h2.net.Incoming("alice-testnet", chat, member, "s-2", "hello while it fails", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello while it fails", h2, "alice"))
	// The failed download keeps what the next try needs: the saved picture, not set, and no
	// picture ID, so a network that fetches only a picture whose ID changed (WhatsApp) fetches
	// it again.
	if mxc, set := ghostAvatar(t, h2, member); mxc != stale || set {
		t.Fatalf("after a failed download the saved picture is %q (set %v), want %q unset", mxc, set, stale)
	}
	var avatarID string
	if err := h2.host.DB.QueryRow(ctx, `SELECT avatar_id FROM ghost WHERE id=$1`, string(member)).Scan(&avatarID); err != nil {
		t.Fatal(err)
	}
	if avatarID != "" {
		t.Fatalf("the failed download left picture ID %q", avatarID)
	}
	if e := lastContact(h2, member, before); e != nil && pictureOf(t, h2, e) != nil {
		t.Fatal("a contact was sent with a picture though none could be downloaded")
	}
	// Once the network's media server works again, the next time they're seen brings it.
	h2.net.BreakPictures(false)
	if err := h2.net.Incoming("alice-testnet", chat, member, "s-3", "hello once it works", time.Now()); err != nil {
		t.Fatal(err)
	}
	waitForPicture(t, h2, member, before, picture)
	h2.host.Stop()
}

// At start, a person who was sent a contact without a picture the host still has a copy of is
// sent it again, without waiting for the contact to be seen.
func TestAContactsPictureTheHostStillHasIsSentAgainAtStart(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-kept")
	member := testconnector.CrowdMember(chat, 1)
	picture := []byte("a picture the host kept")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	if err := h.net.Incoming("alice-testnet", chat, member, "k-1", "hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello", h, "alice"))
	gw.waitFor(t, "the member's contact", isContactOf(h, member))
	h.host.Stop()

	// As if alice had been sent the contact without it, though the host kept its copy.
	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.host.DB.Exec(ctx, `DELETE FROM trioditis_avatar_ref`); err != nil {
		t.Fatal(err)
	}
	before := gw.lastSeq()
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	waitForPicture(t, h2, member, before, picture)
	// And the saved picture is left as it was: nothing needed fetching again.
	if _, set := ghostAvatar(t, h2, member); !set {
		t.Fatal("a picture the host had was marked to be fetched again")
	}
}

// Someone who logged out may still be recorded as having a contact: repairing the contact's
// picture passes them by and still reaches everyone else.
func TestARepairPassesBySomeoneLoggedOut(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice", "bob")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	h.login("bob", "bob-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-shared")
	member := testconnector.CrowdMember(chat, 1)
	picture := []byte("a picture both were sent")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	for _, login := range []networkid.UserLoginID{"bob-testnet", "alice-testnet"} {
		if err := h.net.Incoming(login, chat, member, networkid.MessageID("m-"+string(login)), "hello "+string(login), time.Now()); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "the member's message", isMessage("hello "+string(login), h, map[networkid.UserLoginID]string{"alice-testnet": "alice", "bob-testnet": "bob"}[login]))
	}
	gw.waitFor(t, "the member's contact", isContactOf(h, member))
	h.host.Stop()

	// As if neither had been sent the picture, and bob's login were gone.
	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{`DELETE FROM trioditis_avatar_ref`, `DELETE FROM user_login WHERE id='bob-testnet'`} {
		if _, err := h2.host.DB.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	before := gw.lastSeq()
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	waitForPicture(t, h2, member, before, picture)
}

// A contact's aliases (WhatsApp's phone number and LID ghosts) hold the same upload. When it's
// gone and nobody has a copy, all of them are marked to be fetched again, so the picture one of
// them fetches is set on the others too rather than taken for the one they have.
func TestAContactsAliasesAreMarkedTogether(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	h.login("alice", "alice-testnet")
	ctx := context.Background()
	const chat = networkid.PortalID("crowd-alias")
	// The alias is in no chat of alice's, so nothing else would look at it.
	member, alias := testconnector.CrowdMember(chat, 1), networkid.UserID("alias-of-member")
	picture := []byte("one person's picture")
	if err := h.net.SetPicture(ctx, member, picture); err != nil {
		t.Fatal(err)
	}
	if err := h.net.SetPicture(ctx, alias, picture); err != nil {
		t.Fatal(err)
	}
	if err := h.net.Incoming("alice-testnet", chat, member, "a-1", "hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the member's message", isMessage("hello", h, "alice"))
	gw.waitFor(t, "the member's contact", isContactOf(h, member))
	h.host.Stop()

	// As before kept copies, with the alias holding the member's upload, as a network's aliases do.
	h2 := buildHost(t, dir, gw)
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	stale, _ := ghostAvatar(t, h2, member)
	for _, stmt := range []string{`DELETE FROM trioditis_avatar_kept`, `DELETE FROM trioditis_avatar_ref`} {
		if _, err := h2.host.DB.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h2.host.DB.Exec(ctx, `UPDATE ghost SET avatar_mxc=$1 WHERE id=$2`, stale, string(alias)); err != nil {
		t.Fatal(err)
	}
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	waitMarked(t, h2, member, stale)
	waitMarked(t, h2, alias, stale)
}

package connector

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// Only a part of the message a remote event brings is recorded as in flight: never an error
// notice bridgev2 writes on the side, an edit, or a reaction.
func TestOnlyAMessagesOwnPartsAreInFlight(t *testing.T) {
	message := &simplevent.Message[string]{EventMeta: simplevent.EventMeta{Type: bridgev2.RemoteEventMessage}, ID: "m1"}
	part := &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "m1"}}
	text := &event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgText, Body: "hi"}}
	if !messagePart(message, event.EventMessage, text, part) {
		t.Fatal("a part of the message is its own")
	}
	// bridgev2's notice after a failed conversion has no message metadata.
	notice := &event.Content{Parsed: &event.MessageEventContent{MsgType: event.MsgNotice, Body: "An error occurred"}}
	if messagePart(message, event.EventMessage, notice, &bridgev2.MatrixSendExtra{}) {
		t.Fatal("an error notice counted as the message")
	}
	if messagePart(message, event.EventMessage, text, &bridgev2.MatrixSendExtra{MessageMeta: &database.Message{ID: "other"}}) {
		t.Fatal("another message's part counted")
	}
	reaction := &simplevent.Reaction{EventMeta: simplevent.EventMeta{Type: bridgev2.RemoteEventReaction}}
	if messagePart(reaction, event.EventReaction, &event.Content{Parsed: &event.ReactionEventContent{}}, nil) {
		t.Fatal("a reaction counted as a message part")
	}
	if messagePart(nil, event.EventMessage, text, part) {
		t.Fatal("a write with no remote event counted")
	}
}

func TestAccountHintPrefersTheNumber(t *testing.T) {
	for _, tc := range []struct {
		state status.BridgeState
		want  string
	}{
		{status.BridgeState{RemoteName: "+15551234567", RemoteProfile: status.RemoteProfile{Phone: "+15551234567", Name: "Alice"}}, "+15551234567"},
		{status.BridgeState{RemoteProfile: status.RemoteProfile{Username: "alice", Email: "a@example.com"}}, "@alice"},
		{status.BridgeState{RemoteProfile: status.RemoteProfile{Email: "a@example.com"}}, "a@example.com"},
		{status.BridgeState{RemoteName: "alice-testnet"}, "alice-testnet"},
		{status.BridgeState{}, ""},
	} {
		if got := accountHint(&tc.state); got != tc.want {
			t.Errorf("%+v: got %q, want %q", tc.state, got, tc.want)
		}
	}
}

func TestMentionsThePersonOrTheChat(t *testing.T) {
	for _, tc := range []struct {
		name string
		m    *event.Mentions
		want bool
	}{
		{"none", nil, false},
		{"the person", &event.Mentions{UserIDs: []id.UserID{ids.GhostMXID("bob"), ids.UserMXID("alice")}}, true},
		{"someone else", &event.Mentions{UserIDs: []id.UserID{ids.GhostMXID("alice"), ids.UserMXID("carol")}}, false},
		{"the whole chat", &event.Mentions{Room: true}, true},
	} {
		if got := mentions(tc.m, "alice"); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// A file that can't be stored isn't dropped without a trace: the message keeps a record of it,
// with nothing that could be fetched or decrypted.
func TestAnAttachmentThatCantBeStoredIsKeptAsFailed(t *testing.T) {
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	c.Media = store
	o := &owner{userID: "alice"}
	msg := &event.MessageEventContent{
		MsgType: event.MsgImage, Body: "photo.png", URL: media.ContentURI("AAAAAAAAAAAAAAAAAAAAAA"),
		Info: &event.FileInfo{MimeType: "image/png", Size: 1234, Width: 10, Height: 20},
	}
	plain := c.messagePlaintext(context.Background(), o, event.EventMessage, msg)
	if len(plain.Attachments) != 1 {
		t.Fatalf("the attachment went missing: %+v", plain)
	}
	att := plain.Attachments[0]
	if !att.Failed || att.MediaID != "" || att.Key != "" || att.Nonce != "" {
		t.Fatalf("a failed attachment must say so and carry nothing to fetch: %+v", att)
	}
	if att.Mime != "image/png" || att.Size != 1234 || att.Name != "photo.png" || att.Width != 10 {
		t.Fatalf("the record of the file is incomplete: %+v", att)
	}

	uri := store.Upload([]byte("image bytes"), "photo.png", "image/png")
	msg.URL = uri
	plain = c.messagePlaintext(context.Background(), o, event.EventMessage, msg)
	if att := plain.Attachments[0]; att.Failed || att.MediaID == "" || att.Key == "" {
		t.Fatalf("a stored attachment isn't failed: %+v", att)
	}
}

// An avatar's upload expires in minutes; a metadata change after that still carries the
// avatar: the person's own copy once they were sent it, and before that, a copy made from the
// bridge host's.
func TestAnAvatarIsAttachedAgainAfterItsUploadIsGone(t *testing.T) {
	dir := t.TempDir()
	store, err := media.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	c.Media, c.BridgeKey = store, bridgeKey
	ctx := context.Background()
	uri := store.Upload([]byte("avatar"), "avatar.jpg", "image/jpeg")
	first, known := c.avatarFor(ctx, uri, "alice")
	if first == nil || first.MediaID == "" || known {
		t.Fatal("the avatar wasn't attached while its upload lived")
	}
	// Recorded once the metadata carrying it was sent.
	c.putAvatarRef(ctx, "alice", uri, first)
	// A host restart loses every upload: a new store over the same files.
	c.Media, err = media.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	again, known := c.avatarFor(ctx, uri, "alice")
	if again == nil || *again != *first || !known {
		t.Fatalf("the kept reference wasn't attached again: %+v, want %+v", again, first)
	}
	// Someone new gets a copy of their own, made from the host's.
	other, known := c.avatarFor(ctx, uri, "bob")
	if other == nil || known || other.MediaID == first.MediaID || other.Key == first.Key {
		t.Fatalf("bob's copy: %+v", other)
	}
	// The kept references are sealed to the bridge key, never stored readable.
	kept, err := c.Store.AvatarRef(ctx, "alice", string(uri))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seal.Decode(kept.CT); err != nil || kept.V != seal.Version {
		t.Fatalf("the reference isn't a sealed envelope: %+v", kept)
	}
	c.BridgeKey, _ = seal.GenerateKeyPair()
	if att, _ := c.avatarFor(ctx, uri, "alice"); att != nil {
		t.Fatal("a reference sealed to another key must not open")
	}
}

// A kept copy whose file doesn't decrypt is forgotten, so the contact's picture is fetched again
// rather than taken as one the host still has.
func TestACorruptKeptAvatarIsForgotten(t *testing.T) {
	dir := t.TempDir()
	store, err := media.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	if c.BridgeKey, err = seal.GenerateKeyPair(); err != nil {
		t.Fatal(err)
	}
	c.Media = store
	ctx := context.Background()
	uri := store.Upload([]byte("avatar"), "avatar.jpg", "image/jpeg")
	c.keepAvatar(ctx, uri)
	if c.Media, err = media.New(dir); err != nil {
		t.Fatal(err)
	}
	if !c.hasAvatarCopy(ctx, uri) {
		t.Fatal("the kept copy wasn't kept")
	}
	files, err := os.ReadDir(filepath.Join(dir, "kept"))
	if err != nil || len(files) != 1 {
		t.Fatalf("kept files: %v %v", files, err)
	}
	if err = os.Truncate(filepath.Join(dir, "kept", files[0].Name()), 3); err != nil {
		t.Fatal(err)
	}
	if att, _ := c.avatarFor(ctx, uri, "bob"); att != nil {
		t.Fatal("a corrupt kept copy made a copy")
	}
	if c.hasAvatarCopy(ctx, uri) {
		t.Fatal("a corrupt kept copy still counts")
	}
}

// An avatar from before the host kept its own copies, once its upload is gone, still reaches
// someone new if anyone was sent it: the host's copy is made again from theirs, with no need to
// ask the network.
func TestAnAvatarSomeoneHasIsRecoveredForSomeoneNew(t *testing.T) {
	dir := t.TempDir()
	store, err := media.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	if c.BridgeKey, err = seal.GenerateKeyPair(); err != nil {
		t.Fatal(err)
	}
	c.Media = store
	ctx := context.Background()
	uri := store.Upload([]byte("avatar"), "avatar.jpg", "image/jpeg")
	alice, _ := c.avatarFor(ctx, uri, "alice")
	if alice == nil {
		t.Fatal("alice's copy wasn't made")
	}
	c.putAvatarRef(ctx, "alice", uri, alice)
	// As before kept copies: none, and the upload is gone.
	if err = c.Store.DeleteKeptAvatar(ctx, string(uri)); err != nil {
		t.Fatal(err)
	}
	if c.Media, err = media.New(dir); err != nil {
		t.Fatal(err)
	}
	bob, known := c.avatarFor(ctx, uri, "bob")
	if bob == nil || known || bob.MediaID == alice.MediaID {
		t.Fatalf("bob's copy: %+v", bob)
	}
	f, err := c.Media.Open(bob.MediaID, "bob")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	ct, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := seal.DecryptMedia(ct, bob.Key, bob.Nonce, "bob", bob.MediaID); err != nil || string(got) != "avatar" {
		t.Fatalf("bob's copy opened to %q, %v", got, err)
	}
	if _, err = c.Store.KeptAvatar(ctx, string(uri)); err != nil {
		t.Fatalf("the host's copy wasn't kept again: %v", err)
	}
}

// fakeLogin is a login process the test moves along by hand.
type fakeLogin struct{ cancelled chan struct{} }

func (f *fakeLogin) Start(context.Context) (*bridgev2.LoginStep, error) { return nil, nil }
func (f *fakeLogin) Cancel() {
	select {
	case <-f.cancelled:
	default:
		close(f.cancelled)
	}
}

func lastSteps(t *testing.T, c *Connector) []string {
	t.Helper()
	events, err := c.Store.After(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, evt := range events {
		if evt.Type == protocol.EventLoginStep {
			out = append(out, evt.Step.Type)
		}
	}
	return out
}

func startedSession(c *Connector, id string) *loginSession {
	ctx, cancel := context.WithCancel(c.Bridge.BackgroundCtx)
	s := &loginSession{c: c, id: id, userID: "alice", process: &fakeLogin{cancelled: make(chan struct{})}, ctx: ctx, cancel: cancel}
	c.logins.Store(id, s)
	return s
}

// A cancel and a completion that cross end the login once, with whichever came first.
func TestLoginCancelAndCompleteRaceEndsOnce(t *testing.T) {
	complete := &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeComplete, StepID: "done"}
	cancel := &protocol.Command{Type: protocol.CommandLoginCancel, UserID: "alice"}

	c := testConnector(t)
	first := startedSession(c, "cancelled-first")
	cancel.LoginSessionID = "cancelled-first"
	if err := c.handleLoginCancel(context.Background(), cancel, false); err != nil {
		t.Fatal(err)
	}
	if _, ended := c.endedLogins.Load("cancelled-first"); !ended {
		t.Fatal("a cancelled login is remembered as ended")
	}
	// The completion that lost reports nothing.
	first.advance(complete, nil)
	if steps := lastSteps(t, c); len(steps) != 1 || steps[0] != protocol.StepCancelled {
		t.Fatalf("steps %v, want only the cancel", steps)
	}

	c = testConnector(t)
	won := startedSession(c, "completed-first")
	won.advance(complete, nil)
	cancel.LoginSessionID = "completed-first"
	if err := c.handleLoginCancel(context.Background(), cancel, false); err != nil {
		t.Fatal(err)
	}
	if steps := lastSteps(t, c); len(steps) != 1 || steps[0] != protocol.StepComplete {
		t.Fatalf("steps %v, want only the completion", steps)
	}

	// At the same moment, many times over: never both, never neither.
	for i := range 20 {
		c = testConnector(t)
		sid := "race-" + string(rune('a'+i))
		s := startedSession(c, sid)
		cmd := *cancel
		cmd.LoginSessionID = sid
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); s.advance(complete, nil) }()
		go func() { defer wg.Done(); _ = c.handleLoginCancel(context.Background(), &cmd, false) }()
		wg.Wait()
		if steps := lastSteps(t, c); len(steps) != 1 {
			t.Fatalf("race %d: steps %v, want exactly one last step", i, steps)
		}
	}
}

// A login the person cancelled that completes anyway isn't logged out on the host's own say:
// it is reported as connected, marked afterCancel, for the person to decide. The login still
// ends once (cancelled); the late completion is a report, not a second ending.
func TestALoginCompletedAfterItsCancelIsReportedNotLoggedOut(t *testing.T) {
	c := testConnector(t)
	c.Opaque = ids.NewOpaquer([]byte("test id key"))
	late := startedSession(c, "late")
	if err := c.handleLoginCancel(context.Background(), &protocol.Command{Type: protocol.CommandLoginCancel, UserID: "alice", LoginSessionID: "late"}, false); err != nil {
		t.Fatal(err)
	}
	late.advance(&bridgev2.LoginStep{Type: bridgev2.LoginStepTypeComplete, StepID: "done",
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: "15551234567", UserLogin: &bridgev2.UserLogin{}}}, nil)
	events, err := c.Store.After(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var steps []*protocol.LoginStep
	for _, evt := range events {
		if evt.Type == protocol.EventLoginStep {
			steps = append(steps, evt.Step)
		}
	}
	if len(steps) != 2 || steps[0].Type != protocol.StepCancelled || steps[1].Type != protocol.StepComplete ||
		!steps[1].AfterCancel || steps[1].LoginID == "" {
		t.Fatalf("steps %+v; want the cancel, then a complete marked afterCancel with its login ID", steps)
	}
	if has, err := c.Store.HasLoginSession(context.Background(), "late"); err != nil || has {
		t.Fatalf("the login is still recorded as in progress (%v)", err)
	}
}

// A QR or pairing code says when to stop showing it, and the host moves that on while the
// code is still the login's step, so a code from a host that went down disappears.
func TestALoginCodeExpiresUnlessKeptUp(t *testing.T) {
	old := DisplayLifetime
	DisplayLifetime = 80 * time.Millisecond
	t.Cleanup(func() { DisplayLifetime = old })
	c := testConnector(t)
	s := startedSession(c, "qr")
	s.process = &waitingLogin{fakeLogin: fakeLogin{cancelled: make(chan struct{})}}
	before := time.Now()
	s.advance(&bridgev2.LoginStep{
		Type: bridgev2.LoginStepTypeDisplayAndWait, StepID: "qr-1",
		DisplayAndWaitParams: &bridgev2.LoginDisplayAndWaitParams{Type: bridgev2.LoginDisplayTypeQR, Data: "qr data"},
	}, nil)
	time.Sleep(150 * time.Millisecond)
	events, err := c.Store.After(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	var expiries []int64
	for _, evt := range events {
		if evt.Type == protocol.EventLoginStep && evt.Step.Display != nil {
			expiries = append(expiries, evt.Step.Display.ExpiresAt)
		}
	}
	if len(expiries) < 2 {
		t.Fatalf("the code was reported %d times; want it kept up", len(expiries))
	}
	if expiries[0] < before.UnixMilli() || expiries[0] > before.Add(time.Second).UnixMilli() || expiries[1] <= expiries[0] {
		t.Fatalf("expiries %v", expiries)
	}
	// Once the login moves on (or ends) the old code isn't kept up.
	s.finish()
	n := len(expiries)
	time.Sleep(100 * time.Millisecond)
	events, _ = c.Store.After(context.Background(), 0, 100)
	count := 0
	for _, evt := range events {
		if evt.Type == protocol.EventLoginStep && evt.Step.Display != nil {
			count++
		}
	}
	if count > n+1 {
		t.Fatalf("an ended login's code was still kept up: %d reports after %d", count, n)
	}
}

// waitingLogin waits until cancelled, as a QR login does until the code is scanned.
type waitingLogin struct{ fakeLogin }

func (w *waitingLogin) Wait(ctx context.Context) (*bridgev2.LoginStep, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

package connector

import (
	"context"
	"sync"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

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
// avatar, from the reference kept when it was first attached.
func TestAnAvatarIsAttachedAgainAfterItsUploadIsGone(t *testing.T) {
	store, err := media.New(t.TempDir())
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
	first := c.avatarFor(ctx, uri, "alice")
	if first == nil || first.MediaID == "" {
		t.Fatal("the avatar wasn't attached while its upload lived")
	}
	// A host restart loses every upload: a new store with the same files on disk.
	c.Media, err = media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	again := c.avatarFor(ctx, uri, "alice")
	if again == nil || *again != *first {
		t.Fatalf("the kept reference wasn't attached again: %+v, want %+v", again, first)
	}
	if other := c.avatarFor(ctx, uri, "bob"); other != nil {
		t.Fatal("one person's avatar copy went to another")
	}
	// The kept reference is sealed to the bridge key, never stored readable.
	kept, err := c.Store.AvatarRef(ctx, "alice", string(uri))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seal.Decode(kept.CT); err != nil || kept.V != seal.Version {
		t.Fatalf("the reference isn't a sealed envelope: %+v", kept)
	}
	c.BridgeKey, _ = seal.GenerateKeyPair()
	if c.avatarFor(ctx, uri, "alice") != nil {
		t.Fatal("a reference sealed to another key must not open")
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

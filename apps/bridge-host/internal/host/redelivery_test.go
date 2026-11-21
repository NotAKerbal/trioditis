package host

import (
	"context"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

func init() {
	// Each attempt watched on its own, as a network's handler watches each delivery.
	handled.AddKey(func(remote any) any {
		if m, ok := remote.(*simplevent.Message[[]string]); ok {
			return m
		}
		return nil
	})
}

// A redelivery that arrives while an earlier attempt at the message is still being bridged in
// the background waits for that attempt to settle, then is handled against what it left: none
// of it, if it failed (bridged whole), or all of it, if it succeeded (a duplicate). It is never
// judged against parts the earlier attempt may yet take back.
func TestARedeliveryWaitsForTheEarlierAttemptToSettle(t *testing.T) {
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw)
	defer h.host.Stop()
	h.login("alice", "alice-redeliver")
	const login = networkid.UserLoginID("alice-redeliver")
	ctx := context.Background()
	parts := func(id networkid.MessageID) int {
		saved, err := h.host.Bridge.DB.Message.GetAllPartsByID(ctx, login, id)
		if err != nil {
			t.Fatal(err)
		}
		return len(saved)
	}
	watch := func(evt bridgev2.RemoteEvent) { handled.Begin(evt) }

	for _, tc := range []struct {
		name      string
		succeeds  bool
		wantParts int
	}{
		{"fails", false, 2},
		{"succeeds", true, 1},
	} {
		t.Run("the earlier attempt "+tc.name, func(t *testing.T) {
			id := networkid.MessageID("redelivered-" + tc.name)
			// The earlier attempt saved its first part and is still going (backgrounded): it holds
			// the message, as RemoteEventStart does for it.
			first, err := h.net.IncomingPartsWith(login, "family", "peer-family", id, []string{"first one"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			watch(first)
			bridgev2.RemoteEventStart(first)
			handled.NoteMessage(first, handled.Message{Receiver: string(login), ID: string(id)})
			if err = h.host.Store.PutInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: string(id)}); err != nil {
				t.Fatal(err)
			}

			redelivered := make(chan bool, 1)
			var second bridgev2.RemoteEvent
			go func() {
				evt, err := h.net.IncomingPartsWith(login, "family", "peer-family", id, []string{"first one", "first two"}, watch)
				second = evt
				redelivered <- err == nil
			}()
			select {
			case <-redelivered:
				t.Fatal("the redelivery was handled while the earlier attempt was unsettled")
			case <-time.After(200 * time.Millisecond):
			}

			// The earlier attempt ends: its outcome settles the message, then the redelivery goes.
			res := bridgev2.EventHandlingResultFailed
			if tc.succeeds {
				res = bridgev2.EventHandlingResultSuccess
			}
			bridgev2.RemoteEventDone(first, res)
			select {
			case ok := <-redelivered:
				if !ok {
					t.Fatal("the redelivery failed")
				}
			case <-time.After(10 * time.Second):
				t.Fatal("the redelivery never went after the earlier attempt settled")
			}
			if got := parts(id); got != tc.wantParts {
				t.Fatalf("after the redelivery: %d parts, want %d", got, tc.wantParts)
			}
			if _, watched := handled.Messages(second); watched {
				t.Fatal("the redelivery's outcome wasn't reported")
			}
		})
	}
}

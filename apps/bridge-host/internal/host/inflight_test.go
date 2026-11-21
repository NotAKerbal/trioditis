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

// partsKey is how these tests watch a several-part message, as a network's handler would
// (WhatsApp's, Signal's): by its ID.
func partsKey(id networkid.MessageID) string { return "parts:" + string(id) }

func init() {
	handled.AddKey(func(remote any) any {
		if m, ok := remote.(*simplevent.Message[[]string]); ok {
			return partsKey(m.ID)
		}
		return nil
	})
}

// A message whose network sends it again unless acknowledged is recorded as in flight from its
// first part until bridgev2 says how its handling ended. Ended in failure part way (or cut off
// by a stop), its saved parts are forgotten, so the redelivery is bridged whole rather than
// dropped by bridgev2 as a duplicate; the parts already journaled come again with the same
// event IDs, which the backend applies once.
func TestAMessageCutOffPartWayIsBridgedWholeWhenSentAgain(t *testing.T) {
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw)
	defer h.host.Stop()
	h.login("alice", "alice-parts")
	const login = networkid.UserLoginID("alice-parts")
	ctx := context.Background()
	partEvents := func(texts ...string) map[string]int {
		counts := map[string]int{}
		for _, text := range texts {
			for _, evt := range gw.snapshot() {
				if isMessage(text, h, "alice")(evt) {
					counts[evt.EventID]++
				}
			}
		}
		return counts
	}
	parts := func(id networkid.MessageID) int {
		saved, err := h.host.Bridge.DB.Message.GetAllPartsByID(ctx, login, id)
		if err != nil {
			t.Fatal(err)
		}
		return len(saved)
	}
	inflight := func() int {
		rows, err := h.host.Store.Inflight(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}

	// Handled in full: both parts journaled and saved, nothing left in flight.
	watch := handled.Begin(partsKey("whole"))
	if _, err := h.net.IncomingParts(login, "family", "peer-family", "whole", []string{"whole one", "whole two"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-watch.Finished():
	case <-time.After(10 * time.Second):
		t.Fatal("bridgev2 didn't report the handling's end")
	}
	if !watch.Succeeded() || parts("whole") != 2 || inflight() != 0 {
		t.Fatalf("succeeded %v, parts %d, in flight %d", watch.Succeeded(), parts("whole"), inflight())
	}

	// Its handling failed after the first part was saved: the part is forgotten, and the
	// redelivery is bridged, both parts.
	watch = handled.Begin(partsKey("cut"))
	remote, err := h.net.IncomingParts(login, "family", "peer-family", "cut", []string{"cut one"})
	if err != nil {
		t.Fatal(err)
	}
	<-watch.Finished()
	if parts("cut") != 1 {
		t.Fatal("the first part wasn't saved")
	}
	// What the patched bridgev2 reports when handling ends in failure after that part.
	handled.Begin(partsKey("cut"))
	handled.NoteMessage(remote, handled.Message{Receiver: string(login), ID: "cut"})
	if err = h.host.Store.PutInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: "cut"}); err != nil {
		t.Fatal(err)
	}
	bridgev2.RemoteEventDone(remote, bridgev2.EventHandlingResultFailed)
	if parts("cut") != 0 || inflight() != 0 {
		t.Fatalf("a failed handling left %d parts, %d in flight", parts("cut"), inflight())
	}
	handled.Begin(partsKey("cut"))
	if _, err = h.net.IncomingParts(login, "family", "peer-family", "cut", []string{"cut one", "cut two"}); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "the redelivery's second part", isMessage("cut two", h, "alice"))
	if parts("cut") != 2 {
		t.Fatalf("the redelivery saved %d parts, want 2", parts("cut"))
	}
	for eventID, n := range partEvents("cut one") {
		if n != 2 {
			t.Fatalf("the first part %s was journaled %d times; want again, with the same event ID", eventID, n)
		}
	}

	// Cut off by a stop: in flight at start-up, so its saved parts are forgotten before any
	// login connects and the network sends it again.
	if err = h.host.Store.PutInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: "whole"}); err != nil {
		t.Fatal(err)
	}
	if err = h.host.Connector.RecoverInflight(ctx); err != nil {
		t.Fatal(err)
	}
	if parts("whole") != 0 || inflight() != 0 {
		t.Fatalf("recovery left %d parts, %d in flight", parts("whole"), inflight())
	}
	if _, err = h.net.IncomingParts(login, "family", "peer-family", "whole", []string{"whole one", "whole two"}); err != nil {
		t.Fatal(err)
	}
	if parts("whole") != 2 {
		t.Fatal("the redelivery after a stop wasn't bridged")
	}

	// A redelivery while the first attempt is still bridging the message (its parts in
	// flight; it may yet fail and undo them): bridgev2 takes it for a duplicate, and it is
	// refused rather than acknowledged in that attempt's place.
	if err = h.host.Store.PutInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: "whole"}); err != nil {
		t.Fatal(err)
	}
	watch = handled.Begin(partsKey("whole"))
	if _, err = h.net.IncomingParts(login, "family", "peer-family", "whole", []string{"whole one", "whole two"}); err != nil {
		t.Fatal(err)
	}
	if done, succeeded := watch.Done(); !done || succeeded {
		t.Fatalf("a redelivery of a message still in flight: done %v, succeeded %v; want refused", done, succeeded)
	}
	// Once that attempt settles, a redelivery is the duplicate it is.
	if err = h.host.Store.DeleteInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: "whole"}); err != nil {
		t.Fatal(err)
	}
	watch = handled.Begin(partsKey("whole"))
	if _, err = h.net.IncomingParts(login, "family", "peer-family", "whole", []string{"whole one", "whole two"}); err != nil {
		t.Fatal(err)
	}
	if done, succeeded := watch.Done(); !done || !succeeded {
		t.Fatalf("a settled message's redelivery: done %v, succeeded %v; want taken as a duplicate", done, succeeded)
	}
}

// The outcome is reported only once the message's in-flight record is gone, so a stop just
// after the acknowledgement can't have the next start undo a message the network won't send
// again; and a late failure, after the handler stopped waiting, still undoes its parts.
func TestAMessageIsSettledBeforeItsOutcomeIsReported(t *testing.T) {
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw)
	defer h.host.Stop()
	h.login("alice", "alice-order")
	const login = networkid.UserLoginID("alice-order")
	ctx := context.Background()
	watch := handled.Begin(partsKey("ordered"))
	recordGone := make(chan bool, 1)
	go func() {
		<-watch.Finished()
		inflight, err := h.host.Store.IsInflight(ctx, store.InflightMessage{Receiver: string(login), MessageID: "ordered"})
		recordGone <- err == nil && !inflight
	}()
	if _, err := h.net.IncomingParts(login, "family", "peer-family", "ordered", []string{"ordered one", "ordered two"}); err != nil {
		t.Fatal(err)
	}
	if !<-recordGone {
		t.Fatal("the outcome was reported while the in-flight record was still there")
	}

	// The handler gave up waiting (Begin without a waiter that ends it), and the handling fails
	// afterwards: its parts are still undone.
	remote, err := h.net.IncomingParts(login, "family", "peer-family", "late", []string{"late one"})
	if err != nil {
		t.Fatal(err)
	}
	handled.Begin(partsKey("late"))
	handled.NoteMessage(remote, handled.Message{Receiver: string(login), ID: "late"})
	bridgev2.RemoteEventDone(remote, bridgev2.EventHandlingResultFailed)
	saved, err := h.host.Bridge.DB.Message.GetAllPartsByID(ctx, login, "late")
	if err != nil || len(saved) != 0 {
		t.Fatalf("a late failure left %d parts (%v)", len(saved), err)
	}
}

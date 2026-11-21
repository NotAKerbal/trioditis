package connector

import (
	"context"
	"errors"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

func init() {
	handled.AddKey(func(remote any) any {
		if m, ok := remote.(*simplevent.Message[string]); ok {
			return m
		}
		return nil
	})
}

// Every attempt at a message waits for the one before it to settle, WhatsApp's upserts (whose
// duplicate path answers plain success) included; other messages, and events nobody watches
// for redelivery, don't wait.
func TestAttemptsAtOneMessageGoOneAtATime(t *testing.T) {
	var locks messageLocks
	attempt := func(id networkid.MessageID, kind bridgev2.RemoteEventType, watched bool) bridgev2.RemoteEvent {
		evt := &simplevent.Message[string]{
			EventMeta: simplevent.EventMeta{Type: kind, PortalKey: networkid.PortalKey{ID: "chat", Receiver: "login"}},
			ID:        id,
		}
		if watched {
			handled.Begin(evt)
		}
		return evt
	}
	started := func(evt bridgev2.RemoteEvent) <-chan struct{} {
		ch := make(chan struct{})
		go func() { locks.start(evt); close(ch) }()
		return ch
	}
	waits := func(ch <-chan struct{}) bool {
		select {
		case <-ch:
			return false
		case <-time.After(100 * time.Millisecond):
			return true
		}
	}

	first := attempt("m1", bridgev2.RemoteEventMessageUpsert, true)
	locks.start(first)
	second := attempt("m1", bridgev2.RemoteEventMessageUpsert, true)
	secondStarted := started(second)
	if !waits(secondStarted) {
		t.Fatal("a second attempt at the same upsert didn't wait")
	}
	other := attempt("m2", bridgev2.RemoteEventMessage, true)
	if waits(started(other)) {
		t.Fatal("another message waited")
	}
	unwatched := attempt("m1", bridgev2.RemoteEventMessage, false)
	if waits(started(unwatched)) {
		t.Fatal("an event nobody watches waited")
	}
	locks.done(first)
	if waits(secondStarted) {
		t.Fatal("the second attempt didn't go once the first settled")
	}
	locks.done(second)
	locks.done(other)
	locks.done(unwatched) // never held: nothing to let go
	if len(locks.held) != 0 {
		t.Fatalf("locks left held: %v", locks.held)
	}
}

// An earlier attempt whose cleanup failed (the database down) left its record: the next
// delivery settles it before bridgev2 looks for a duplicate, and if that fails too, the
// delivery isn't acknowledged, whatever bridgev2 answers (an upsert answers plain success).
func TestALeftoverAttemptIsSettledFirstOrTheDeliveryFails(t *testing.T) {
	c := testConnector(t)
	ctx := context.Background()
	m := store.InflightMessage{Receiver: "login", MessageID: "m1"}
	delivery := func() bridgev2.RemoteEvent {
		evt := &simplevent.Message[string]{
			EventMeta: simplevent.EventMeta{Type: bridgev2.RemoteEventMessageUpsert, PortalKey: networkid.PortalKey{ID: "chat", Receiver: "login"}},
			ID:        "m1",
		}
		handled.Begin(evt)
		return evt
	}
	var undone []store.InflightMessage
	failing := errors.New("database unavailable")
	old := undoParts
	t.Cleanup(func() { undoParts = old })

	// The database is still down: the delivery fails.
	undoParts = func(*Connector, context.Context, store.InflightMessage) error { return failing }
	if err := c.Store.PutInflight(ctx, m); err != nil {
		t.Fatal(err)
	}
	evt := delivery()
	watch := handled.Begin(evt)
	c.remoteEventStart(evt)
	c.remoteEventDone(evt, bridgev2.EventHandlingResultSuccess) // bridgev2's upsert: plain success
	if done, succeeded := watch.Done(); !done || succeeded {
		t.Fatalf("a delivery over an unsettled attempt: done %v, succeeded %v; want failed", done, succeeded)
	}

	// It's back: the leftover parts are undone and the record cleared, before handling.
	undoParts = func(_ *Connector, _ context.Context, m store.InflightMessage) error {
		undone = append(undone, m)
		return nil
	}
	evt = delivery()
	watch = handled.Begin(evt)
	c.remoteEventStart(evt)
	if len(undone) != 1 || undone[0] != m {
		t.Fatalf("undone before handling: %v", undone)
	}
	if inflight, err := c.Store.IsInflight(ctx, m); err != nil || inflight {
		t.Fatalf("the leftover record is still there (%v)", err)
	}
	c.remoteEventDone(evt, bridgev2.EventHandlingResultSuccess)
	if done, succeeded := watch.Done(); !done || !succeeded {
		t.Fatalf("a delivery once the leftover was settled: done %v, succeeded %v", done, succeeded)
	}
}

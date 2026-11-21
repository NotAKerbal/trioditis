package connector

import (
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
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

package handled

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type remote struct{ key *int }

func init() {
	AddKey(func(r any) any {
		if r, ok := r.(remote); ok {
			return r.key
		}
		return nil
	})
}

// A handler that stopped waiting (its wait ran out) leaves the event watched: a handling that
// fails later still finds the messages it noted, so the connector can undo them before the
// network sends the message again.
func TestAnEventStaysWatchedAfterItsHandlerGaveUp(t *testing.T) {
	a := &Acker{Limit: 10 * time.Millisecond, MaxWait: 30 * time.Millisecond, Ctx: context.Background(), Log: zerolog.Nop()}
	key := new(int)
	ok := a.Handle(key, func() bool {
		NoteMessage(remote{key}, Message{Receiver: "l", ID: "m"})
		time.Sleep(20 * time.Millisecond)
		return true
	})
	if ok {
		t.Fatal("an event whose handling didn't end in time was acknowledged")
	}
	messages, watched := Messages(remote{key})
	if !watched || len(messages) != 1 || messages[0].ID != "m" {
		t.Fatalf("after the wait ran out: watched %v, messages %v", watched, messages)
	}
	Finished(remote{key}, false)
	if _, watched = Messages(remote{key}); watched {
		t.Fatal("an event whose outcome came is still watched")
	}
}

// An outcome reported while bridgev2 still answered within the limit stands over its answer:
// a redelivery it took for a duplicate of a message still being bridged isn't acknowledged.
func TestAQuickOutcomeOverridesTheAnswer(t *testing.T) {
	a := &Acker{Limit: time.Second, MaxWait: time.Second, Ctx: context.Background(), Log: zerolog.Nop()}
	key := new(int)
	if a.Handle(key, func() bool { Finished(remote{key}, false); return true }) {
		t.Fatal("a refused redelivery was acknowledged")
	}
	other := new(int)
	if !a.Handle(other, func() bool { Finished(remote{other}, true); return true }) {
		t.Fatal("a handled event wasn't acknowledged")
	}
	if !a.Handle(new(int), func() bool { return true }) {
		t.Fatal("an event never handed to bridgev2 keeps its handler's answer")
	}
}

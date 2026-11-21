package wabuffer

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
)

// remoteFor stands in for mautrix-whatsapp's remote event, which carries the whatsmeow message.
type remoteFor struct{ msg *events.Message }

func init() {
	handled.AddKey(func(remote any) any {
		if r, ok := remote.(remoteFor); ok {
			return r.msg
		}
		return nil
	})
}

func testAcker(ctx context.Context) *Acker {
	return &Acker{Limit: 50 * time.Millisecond, Settle: 30 * time.Millisecond, MaxWait: 300 * time.Millisecond, Ctx: ctx, Log: zerolog.Nop()}
}

func TestAckerPassesQuickAnswersThrough(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if !a.Wrap(func(any) bool { return true })(msg) {
		t.Fatal("a handler that finished in time succeeded")
	}
	if a.Wrap(func(any) bool { return false })(msg) {
		t.Fatal("a handler that failed must stay failed")
	}
	if !a.Wrap(func(any) bool { time.Sleep(80 * time.Millisecond); return true })(&events.Receipt{}) {
		t.Fatal("only messages are held back")
	}
}

// bridgev2 says success at its limit while the message is still being handled: the message is
// acknowledged only once it is journaled.
func TestAckerWaitsForABackgroundedMessage(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	journaledAt := make(chan time.Time, 1)
	handler := a.Wrap(func(any) bool {
		time.Sleep(60 * time.Millisecond) // past the limit: bridgev2 backgrounded it
		go func() {
			time.Sleep(40 * time.Millisecond)
			journaledAt <- time.Now()
			handled.Journaled(remoteFor{msg})
		}()
		return true
	})
	if !handler(msg) {
		t.Fatal("a message journaled in the background is acknowledged")
	}
	select {
	case <-journaledAt:
	default:
		t.Fatal("acknowledged before it was journaled")
	}
}

// Never journaled (the process stopping meanwhile, say): it isn't acknowledged, so WhatsApp
// sends it again.
func TestAckerDoesntAcknowledgeAnUnjournaledMessage(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if a.Wrap(func(any) bool { time.Sleep(60 * time.Millisecond); return true })(msg) {
		t.Fatal("a backgrounded message never journaled must not be acknowledged")
	}
	// Another message's journaling doesn't count for this one.
	other := &events.Message{}
	if a.Wrap(func(any) bool {
		time.Sleep(60 * time.Millisecond)
		handled.Journaled(remoteFor{other})
		return true
	})(msg) {
		t.Fatal("another message's journaling was taken for this one's")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if testAcker(ctx).Wrap(func(any) bool { time.Sleep(60 * time.Millisecond); return true })(msg) {
		t.Fatal("a stopping host must not acknowledge it")
	} else if time.Since(start) > 200*time.Millisecond {
		t.Fatal("a stopping host shouldn't wait")
	}
}

// A message journaled just as the limit passed is acknowledged after the journal settles.
func TestAckerAcknowledgesOnceJournaledParts(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if !a.Wrap(func(any) bool {
		handled.Journaled(remoteFor{msg})
		time.Sleep(60 * time.Millisecond)
		return true
	})(msg) {
		t.Fatal("a message journaled before the handler returned is acknowledged")
	}
}

func TestWrapHandlersWrapsWhatsmeowsList(t *testing.T) {
	cli := &whatsmeow.Client{}
	var called []string
	cli.AddEventHandlerWithSuccessStatus(func(any) bool { called = append(called, "orig"); return true })
	err := WrapHandlers(cli, func(next whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
		return func(evt any) bool {
			called = append(called, "wrapper")
			next(evt)
			return false
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	// whatsmeow dispatches to the handlers in its list; RemoveEventHandler finds the entry
	// still registered under its ID, so only fn changed.
	var wrapped whatsmeow.EventHandlerWithSuccessStatus
	_ = WrapHandlers(cli, func(next whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
		wrapped = next
		return next
	})
	if wrapped == nil || wrapped(nil) {
		t.Fatal("the handler in whatsmeow's list isn't the wrapper")
	}
	if len(called) != 2 || called[0] != "wrapper" || called[1] != "orig" {
		t.Fatalf("calls %v", called)
	}
}

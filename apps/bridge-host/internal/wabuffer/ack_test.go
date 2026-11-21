package wabuffer

import (
	"context"
	"errors"
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

func testAcker(ctx context.Context) *handled.Acker {
	return &handled.Acker{Limit: 50 * time.Millisecond, Settle: 30 * time.Millisecond, MaxWait: 300 * time.Millisecond, Ctx: ctx, Log: zerolog.Nop()}
}

// write reports one write for msg, as the connector does: own says it is the message's own.
func write(msg *events.Message, err error, own bool) {
	handled.Writing(remoteFor{msg})(err, own)
}

// backgrounded is a handler bridgev2 gave up waiting for: it returns success past the limit,
// and then carries on with the writes in the background.
func backgrounded(msg *events.Message, after func()) func(any) bool {
	return func(any) bool {
		time.Sleep(60 * time.Millisecond)
		go after()
		return true
	}
}

func TestAckerPassesQuickAnswersThrough(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if !WrapAck(a)(func(any) bool { return true })(msg) {
		t.Fatal("a handler that finished in time succeeded")
	}
	if WrapAck(a)(func(any) bool { return false })(msg) {
		t.Fatal("a handler that failed must stay failed")
	}
	if !WrapAck(a)(func(any) bool { time.Sleep(80 * time.Millisecond); return true })(&events.Receipt{}) {
		t.Fatal("only messages are held back")
	}
}

// bridgev2 says success at its limit while the message is still being handled: the message is
// acknowledged only once it is journaled.
func TestAckerWaitsForABackgroundedMessage(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	journaled := make(chan struct{})
	ok := WrapAck(a)(backgrounded(msg, func() {
		time.Sleep(40 * time.Millisecond)
		write(msg, nil, true)
		close(journaled)
	}))(msg)
	if !ok {
		t.Fatal("a message journaled in the background is acknowledged")
	}
	select {
	case <-journaled:
	default:
		t.Fatal("acknowledged before it was journaled")
	}
}

// Only the message's own write counts: the error notice bridgev2 journals when converting the
// message failed, or the removal of a reaction being replaced, followed by nothing more (a
// stall, or bridgev2 giving up), mustn't acknowledge it.
func TestAckerIgnoresWritesOnTheSide(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if WrapAck(a)(backgrounded(msg, func() { write(msg, nil, false) }))(msg) {
		t.Fatal("a side write followed by a stall acknowledged the message")
	}
}

// A message journaled in part, whose next part then fails, isn't acknowledged, and neither is
// one whose next write is still running when the wait runs out.
func TestAckerDoesntAcknowledgeAPartialMessage(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	start := time.Now()
	if WrapAck(a)(backgrounded(msg, func() {
		write(msg, nil, true)
		write(msg, errors.New("part 2 failed"), true)
	}))(msg) {
		t.Fatal("a message with a failed part was acknowledged")
	} else if time.Since(start) > 250*time.Millisecond {
		t.Fatal("a failed write should end the wait at once")
	}
	stalled := &events.Message{}
	if WrapAck(a)(backgrounded(stalled, func() {
		write(stalled, nil, true)
		_ = handled.Writing(remoteFor{stalled}) // part 2 starts and never ends
	}))(stalled) {
		t.Fatal("a message whose next part stalled was acknowledged")
	}
}

// Never journaled (the process stopping meanwhile, say): it isn't acknowledged, so WhatsApp
// sends it again.
func TestAckerDoesntAcknowledgeAnUnjournaledMessage(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if WrapAck(a)(func(any) bool { time.Sleep(60 * time.Millisecond); return true })(msg) {
		t.Fatal("a backgrounded message never journaled must not be acknowledged")
	}
	// Another message's journaling doesn't count for this one.
	other := &events.Message{}
	if WrapAck(a)(backgrounded(msg, func() { write(other, nil, true) }))(msg) {
		t.Fatal("another message's journaling was taken for this one's")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if WrapAck(testAcker(ctx))(func(any) bool { time.Sleep(60 * time.Millisecond); return true })(msg) {
		t.Fatal("a stopping host must not acknowledge it")
	} else if time.Since(start) > 200*time.Millisecond {
		t.Fatal("a stopping host shouldn't wait")
	}
}

// A message journaled just as the limit passed is acknowledged after the journal settles.
func TestAckerAcknowledgesOnceJournaledParts(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if !WrapAck(a)(func(any) bool {
		write(msg, nil, true)
		time.Sleep(60 * time.Millisecond)
		return true
	})(msg) {
		t.Fatal("a message journaled before the handler returned is acknowledged")
	}
}

func TestWrapHandlersWrapsWhatsmeowsList(t *testing.T) {
	if err := WrapHandlers(&whatsmeow.Client{}, func(next whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
		return next
	}); !errors.Is(err, ErrNoHandlers) {
		t.Fatalf("a client with no handlers must be refused, got %v", err)
	}
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

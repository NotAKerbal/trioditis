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
	return &handled.Acker{Limit: 50 * time.Millisecond, MaxWait: 300 * time.Millisecond, Ctx: ctx, Log: zerolog.Nop()}
}

// backgrounded is a handler bridgev2 gave up waiting for: it returns success past the limit,
// and the handling ends later, as after reports through the patched bridgev2.
func backgrounded(after func()) whatsmeow.EventHandlerWithSuccessStatus {
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
// acknowledged only once bridgev2 says its handling really ended, and succeeded. A message
// whose parts are journaled one by one, with a slow save between them, is still waited for:
// what counts is the handler's own end, not the journal going quiet.
func TestAckerWaitsForTheRealOutcome(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	ended := make(chan struct{})
	ok := WrapAck(a)(backgrounded(func() {
		handled.NoteMessage(remoteFor{msg}, handled.Message{Receiver: "l", ID: "m"}) // part 1
		time.Sleep(120 * time.Millisecond)                                           // a slow save
		handled.NoteMessage(remoteFor{msg}, handled.Message{Receiver: "l", ID: "m"}) // part 2
		close(ended)
		handled.Finished(remoteFor{msg}, true)
	}))(msg)
	if !ok {
		t.Fatal("a message handled in full in the background is acknowledged")
	}
	select {
	case <-ended:
	default:
		t.Fatal("acknowledged before the last part")
	}
}

// A handling that fails (a part that couldn't be sent or saved), or never ends, or a host that
// is stopping: not acknowledged, so WhatsApp sends it again.
func TestAckerDoesntAcknowledgeAFailedOrUnfinishedMessage(t *testing.T) {
	a := testAcker(context.Background())
	failed := &events.Message{}
	if WrapAck(a)(backgrounded(func() { handled.Finished(remoteFor{failed}, false) }))(failed) {
		t.Fatal("a message whose handling failed was acknowledged")
	}
	stuck := &events.Message{}
	if WrapAck(a)(backgrounded(func() {}))(stuck) {
		t.Fatal("a message whose handling never ended was acknowledged")
	}
	other := &events.Message{}
	if WrapAck(a)(backgrounded(func() { handled.Finished(remoteFor{&events.Message{}}, true) }))(other) {
		t.Fatal("another message's outcome was taken for this one's")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if WrapAck(testAcker(ctx))(backgrounded(func() {}))(&events.Message{}) {
		t.Fatal("a stopping host must not acknowledge it")
	} else if time.Since(start) > 200*time.Millisecond {
		t.Fatal("a stopping host shouldn't wait")
	}
}

// The outcome reported before the handler returned (bridgev2 finished just as its limit
// passed) is the one that counts.
func TestAckerTakesAnOutcomeThatCameFirst(t *testing.T) {
	a := testAcker(context.Background())
	msg := &events.Message{}
	if !WrapAck(a)(func(any) bool {
		time.Sleep(60 * time.Millisecond)
		handled.Finished(remoteFor{msg}, true)
		return true
	})(msg) {
		t.Fatal("a message whose handling succeeded is acknowledged")
	}
}

// A handling that fails after its handler gave up waiting still reports the messages it
// noted, so they can be undone for the redelivery.
func TestALateFailureStillReportsItsMessages(t *testing.T) {
	a := &handled.Acker{Limit: 10 * time.Millisecond, MaxWait: time.Hour, Ctx: context.Background(), Log: zerolog.Nop()}
	msg := &events.Message{}
	got := make(chan []handled.Message, 1)
	stop, cancel := context.WithCancel(context.Background())
	a.Ctx = stop
	go func() {
		time.Sleep(40 * time.Millisecond)
		cancel() // the handler stops waiting (the host is stopping)
		time.Sleep(20 * time.Millisecond)
		messages, _ := handled.Messages(remoteFor{msg})
		handled.Finished(remoteFor{msg}, false)
		got <- messages
	}()
	WrapAck(a)(func(any) bool {
		handled.NoteMessage(remoteFor{msg}, handled.Message{Receiver: "l", ID: "m"})
		time.Sleep(20 * time.Millisecond)
		return true
	})(msg)
	if messages := <-got; len(messages) != 1 || messages[0].ID != "m" {
		t.Fatalf("a late failure reported %v", messages)
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

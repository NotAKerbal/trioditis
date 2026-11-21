//go:build libsignal

package networks

import (
	"context"
	"testing"
	"time"

	"github.com/rs/zerolog"
	signal "go.mau.fi/mautrix-signal/pkg/connector"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/events"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
)

// signalmeow acknowledges an envelope once its handler returns success, and bridgev2 says
// success at its handler limit while the message is still being handled: a backgrounded
// message is acknowledged only once its own write reaches the journal.
func TestSignalMessageIsAcknowledgedOnlyOnceJournaled(t *testing.T) {
	a := &handled.Acker{Limit: 50 * time.Millisecond, Settle: 30 * time.Millisecond, MaxWait: 300 * time.Millisecond, Ctx: context.Background(), Log: zerolog.Nop()}
	backgrounded := func(chat *events.ChatEvent, journal bool) func(events.SignalEvent) bool {
		return func(events.SignalEvent) bool {
			time.Sleep(60 * time.Millisecond)
			if journal {
				go func() {
					// What the connector reports for a write of bridgev2's remote event.
					handled.Writing(&signal.Bv2ChatEvent{ChatEvent: chat})(nil, true)
				}()
			}
			return true
		}
	}
	journaled := &events.ChatEvent{}
	if !wrapSignalAck(a, backgrounded(journaled, true))(journaled) {
		t.Fatal("a message journaled in the background is acknowledged")
	}
	lost := &events.ChatEvent{}
	if wrapSignalAck(a, backgrounded(lost, false))(lost) {
		t.Fatal("a backgrounded message never journaled must not be acknowledged")
	}
	// Other events pass straight through.
	if !wrapSignalAck(a, func(events.SignalEvent) bool { time.Sleep(60 * time.Millisecond); return true })(&events.QueueEmpty{}) {
		t.Fatal("only chat events are held back")
	}
}

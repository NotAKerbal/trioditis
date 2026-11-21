package handled

import (
	"context"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
)

// Acker holds back a network's acknowledgement of an incoming event until bridgev2's handling
// of it has really ended, and says success only if it succeeded. The networks that acknowledge
// an event once their handler returns success (WhatsApp's whatsmeow, Signal's signalmeow) hand
// bridgev2 the event and return what it says, and bridgev2 says success when its handler limit
// passes, while the event is still being handled in the background. Acknowledged then, an event
// the process stops before journaling is gone: the network doesn't send it again.
//
// A handler that returned before the limit was waited for in full, and its answer stands. One
// that took as long as the limit may have been backgrounded: Handle waits for the outcome
// bridgev2 reports when the handler really returns (Finished), every part of a message
// journaled and saved. If that doesn't come in MaxWait, or the host is stopping, it says
// failure, so the event isn't acknowledged and the network sends it again; what of it was
// journaled is deduplicated by event ID.
type Acker struct {
	// Limit is how long a handler may take before bridgev2 may have backgrounded it.
	Limit time.Duration
	// MaxWait bounds how long a backgrounded event is waited for.
	MaxWait time.Duration
	// Ctx ends the wait when the host stops.
	Ctx context.Context
	// Log must not carry the login's raw ID (a phone number on WhatsApp).
	Log zerolog.Logger
}

// NewAcker waits as long as bridgev2's own handler limit allows, less a margin for the time
// between the network handler starting its clock and bridgev2 starting its own.
func NewAcker(ctx context.Context, log zerolog.Logger) *Acker {
	limit := time.Duration(bridgev2.EventHandlingTimeoutTicks)*30*time.Second - 5*time.Second
	return &Acker{Limit: limit, MaxWait: 20 * time.Minute, Ctx: ctx, Log: log}
}

// Handle runs next, the network's own handling of the event key (a pointer the network's
// keyer finds again in bridgev2's remote event, AddKey), and says whether the event can be
// acknowledged.
func (a *Acker) Handle(key any, next func() bool) bool {
	h := Begin(key)
	start := time.Now()
	ok := next()
	if time.Since(start) < a.Limit {
		// Handled in full while the handler waited (or never handed to bridgev2 at all).
		h.Forget()
		return ok
	}
	defer h.End()
	if !ok {
		return false
	}
	deadline := time.NewTimer(a.MaxWait)
	defer deadline.Stop()
	select {
	case <-h.Finished():
		if !h.Succeeded() {
			a.Log.Warn().Msg("An event handled in the background failed; leaving it unacknowledged")
			return false
		}
		return true
	case <-deadline.C:
		// Not acknowledged, so the network sends it again; the copy that arrives is bridged
		// (or deduplicated, if this one got to the journal meanwhile).
		a.Log.Warn().Msg("An event handled in the background didn't finish in time; leaving it unacknowledged")
		// A handling that ends later is cleaned up at the next start (RecoverInflight).
		h.Forget()
		return false
	case <-a.Ctx.Done():
		return false
	}
}

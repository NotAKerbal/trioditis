package handled

import (
	"context"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
)

// Acker holds back a network's acknowledgement of an incoming event until bridgev2's handling
// of it reached the journal. The networks that acknowledge an event once their handler
// returns success (WhatsApp's whatsmeow, Signal's signalmeow) hand bridgev2 the event and
// return what it says, and bridgev2 says success when its handler limit passes, while the
// event is still being handled in the background. Acknowledged then, an event the process
// stops before journaling is gone: the network doesn't send it again.
//
// A handler that returned before the limit was waited for in full, and its answer stands. One
// that took as long as the limit may have been backgrounded: Handle waits for the event's own
// write to be journaled, with no write failed or still running, before it says success. If
// that doesn't happen in MaxWait, a write fails, or the host is stopping, it says failure, so
// the event isn't acknowledged and the network sends it again; an event journaled twice is
// deduplicated by its event ID.
type Acker struct {
	// Limit is how long a handler may take before bridgev2 may have backgrounded it.
	Limit time.Duration
	// Settle is how long the journal must go quiet after the event's own write before the
	// rest is taken to be journaled too (a message's parts are journaled one after another).
	Settle time.Duration
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
	return &Acker{Limit: limit, Settle: 2 * time.Second, MaxWait: 20 * time.Minute, Ctx: ctx, Log: log}
}

// Handle runs next, the network's own handling of the event key (a pointer the network's
// keyer finds again in bridgev2's remote event, AddKey), and says whether the event can be
// acknowledged.
func (a *Acker) Handle(key any, next func() bool) bool {
	h := Begin(key)
	defer h.End()
	start := time.Now()
	if !next() {
		return false
	}
	if time.Since(start) < a.Limit {
		return true
	}
	return a.wait(h)
}

// settled is a state the event can be acknowledged in.
func settled(s State) bool { return s.Done && s.Running == 0 && !s.Failed }

// wait reports whether the event was journaled: one of its own writes (a part of the message,
// the reaction itself, the edit) reached the journal, none failed, none is still running, and
// nothing more happened for Settle. Writes on the side, such as the error notice bridgev2
// sends when converting a message failed, or the removal of a reaction being replaced, don't
// count: either can be journaled while the event itself never is.
func (a *Acker) wait(h *Handling) bool {
	deadline := time.NewTimer(a.MaxWait)
	defer deadline.Stop()
	settle := time.NewTimer(a.Settle)
	defer settle.Stop()
	if !settled(h.State()) {
		settle.Stop()
	}
	for {
		select {
		case <-h.Changed():
			state := h.State()
			if state.Failed {
				// bridgev2 gives up on an event one of whose writes failed: it isn't
				// acknowledged, so the network sends it again.
				a.Log.Warn().Msg("An event handled in the background failed to journal; leaving it unacknowledged")
				return false
			}
			if settled(state) {
				settle.Reset(a.Settle)
			} else {
				settle.Stop()
			}
		case <-settle.C:
			if settled(h.State()) {
				return true
			}
		case <-deadline.C:
			// Not acknowledged, so the network sends it again; the copy that arrives is
			// bridged (or deduplicated, if this one got to the journal meanwhile).
			a.Log.Warn().Bool("part_journaled", h.State().Done).Msg("An event handled in the background wasn't journaled in time; leaving it unacknowledged")
			return false
		case <-a.Ctx.Done():
			return false
		}
	}
}

package wabuffer

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"time"
	"unsafe"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
)

// whatsmeow acknowledges an incoming message (and clears its buffered plaintext) as soon as
// every event handler returns success. mautrix-whatsapp's handler returns what bridgev2 says,
// and bridgev2 says success when its handler limit passes, while the message is still being
// handled in the background. Acknowledged then, a message the process stops before journaling
// is gone: WhatsApp doesn't send it again.
//
// Acker wraps the handler so that doesn't happen. A handler that returned before the limit
// was waited for in full, and its answer stands. One that took as long as the limit may have
// been backgrounded: the wrapper waits for the message to be journaled before it says
// success. If that doesn't happen in MaxWait, or the host is stopping, it says failure, so
// the message isn't acknowledged and WhatsApp sends it again; a message journaled twice is
// deduplicated by its event ID.
type Acker struct {
	// Limit is how long a handler may take before bridgev2 may have backgrounded it.
	Limit time.Duration
	// Settle is how long the journal must go quiet after a part of the message before the
	// rest is taken to be journaled too (a message's parts are journaled one after another).
	Settle time.Duration
	// MaxWait bounds how long a backgrounded message is waited for.
	MaxWait time.Duration
	// Ctx ends the wait when the host stops.
	Ctx context.Context
	Log zerolog.Logger
}

// NewAcker waits as long as bridgev2's own handler limit allows, less a margin for the time
// between this wrapper starting its clock and bridgev2 starting its own.
func NewAcker(ctx context.Context, log zerolog.Logger) *Acker {
	limit := time.Duration(bridgev2.EventHandlingTimeoutTicks)*30*time.Second - 5*time.Second
	return &Acker{Limit: limit, Settle: 2 * time.Second, MaxWait: 20 * time.Minute, Ctx: ctx, Log: log}
}

// Wrap is the handler to give whatsmeow in place of next.
func (a *Acker) Wrap(next whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
	return func(evt any) bool {
		msg, ok := evt.(*events.Message)
		if !ok {
			return next(evt)
		}
		h := handled.Begin(msg)
		defer h.End()
		start := time.Now()
		if !next(evt) {
			return false
		}
		if time.Since(start) < a.Limit {
			return true
		}
		return a.wait(h)
	}
}

// wait reports whether the message was journaled: once a part of it was, and no further part
// came for Settle.
func (a *Acker) wait(h *handled.Handling) bool {
	deadline := time.NewTimer(a.MaxWait)
	defer deadline.Stop()
	var settle *time.Timer
	defer func() {
		if settle != nil {
			settle.Stop()
		}
	}()
	for {
		journaled := settle != nil
		var settled <-chan time.Time
		if journaled {
			settled = settle.C
		}
		select {
		case <-h.Noted():
			if settle == nil {
				settle = time.NewTimer(a.Settle)
			} else {
				settle.Reset(a.Settle)
			}
		case <-settled:
			return true
		case <-deadline.C:
			// Not acknowledged, so WhatsApp sends it again; the copy that arrives is bridged
			// (or deduplicated, if this one got to the journal meanwhile).
			a.Log.Warn().Bool("part_journaled", journaled).Msg("A WhatsApp message handled in the background wasn't journaled in time; leaving it unacknowledged")
			return false
		case <-a.Ctx.Done():
			return false
		}
	}
}

// ErrNoHandlers is a whatsmeow client whose handler list this version of the host can't find.
var ErrNoHandlers = errors.New("wabuffer: whatsmeow's event handler list isn't where it was")

// WrapHandlers replaces each of cli's event handlers with wrap's version of it. whatsmeow has
// no way to wrap a handler another package registered (mautrix-whatsapp's, here), so this
// reaches into its unexported list; a whatsmeow update that moves it fails the tests and
// returns ErrNoHandlers rather than going unwrapped silently.
func WrapHandlers(cli *whatsmeow.Client, wrap func(whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus) error {
	v := reflect.ValueOf(cli).Elem()
	list := v.FieldByName("eventHandlers")
	lockField := v.FieldByName("eventHandlersLock")
	if !list.IsValid() || list.Kind() != reflect.Slice || !lockField.IsValid() || lockField.Type() != reflect.TypeFor[sync.RWMutex]() {
		return ErrNoHandlers
	}
	elem := list.Type().Elem()
	fn, ok := elem.FieldByName("fn")
	if elem.Kind() != reflect.Struct || !ok || fn.Type != reflect.TypeFor[whatsmeow.EventHandlerWithSuccessStatus]() {
		return ErrNoHandlers
	}
	mu := (*sync.RWMutex)(unsafe.Pointer(lockField.UnsafeAddr()))
	mu.Lock()
	defer mu.Unlock()
	list = reflect.NewAt(list.Type(), unsafe.Pointer(list.UnsafeAddr())).Elem()
	for i := range list.Len() {
		field := list.Index(i).FieldByIndex(fn.Index)
		field = reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem()
		orig := field.Interface().(whatsmeow.EventHandlerWithSuccessStatus)
		field.Set(reflect.ValueOf(wrap(orig)))
	}
	return nil
}

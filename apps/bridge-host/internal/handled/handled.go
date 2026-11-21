// Package handled lets a network's event handler learn that bridgev2's handling of one of its
// incoming events has got as far as the bridge host's journal.
//
// bridgev2 stops waiting for a handler after its handler limit (5 minutes) and reports
// success while the handler carries on in the background. A network that acknowledges an
// event once its handler returns (WhatsApp) would then acknowledge a message that isn't
// journaled yet, and lose it if the process stopped before it was. The network's handler
// marks the event as in flight (Begin); the connector reports each write bridgev2 makes for
// that event (Writing), saying whether it is the write the event exists for (a message's
// part, a reaction's add, an edit) or something on the side (an error notice after a failed
// conversion, the removal of a reaction being replaced); and the handler waits for the
// event's own write, with no write still running and none failed, before acknowledging.
package handled

import (
	"sync"
)

// State is what the connector has reported for an event so far.
type State struct {
	// Running is how many writes are under way.
	Running int
	// Done is whether one of the event's own writes reached the journal.
	Done bool
	// Failed is whether any write for the event failed.
	Failed bool
}

// Handling is one incoming event whose handler is waiting to learn it was journaled.
type Handling struct {
	key     any
	changed chan struct{}

	lock  sync.Mutex
	state State
}

// Changed receives after the State changed since it last did.
func (h *Handling) Changed() <-chan struct{} { return h.changed }

// State is what has been reported so far.
func (h *Handling) State() State {
	h.lock.Lock()
	defer h.lock.Unlock()
	return h.state
}

func (h *Handling) update(fn func(*State)) {
	h.lock.Lock()
	fn(&h.state)
	h.lock.Unlock()
	select {
	case h.changed <- struct{}{}:
	default:
	}
}

// End stops watching the event. Writes after it are not reported.
func (h *Handling) End() {
	lock.Lock()
	defer lock.Unlock()
	if inFlight[h.key] == h {
		delete(inFlight, h.key)
	}
}

var (
	lock     sync.Mutex
	inFlight = map[any]*Handling{}
	keyers   []func(remote any) any
)

// AddKey registers how to find, in a bridgev2 remote event, the network's own event that a
// handler passed to Begin. It returns nil for a remote event it doesn't know.
func AddKey(key func(remote any) any) {
	lock.Lock()
	defer lock.Unlock()
	keyers = append(keyers, key)
}

// Begin watches the network's event key (a pointer, compared by identity) until End.
func Begin(key any) *Handling {
	h := &Handling{key: key, changed: make(chan struct{}, 1)}
	lock.Lock()
	defer lock.Unlock()
	inFlight[key] = h
	return h
}

func find(remote any) *Handling {
	if remote == nil {
		return nil
	}
	lock.Lock()
	defer lock.Unlock()
	for _, keyer := range keyers {
		if key := keyer(remote); key != nil {
			if h, ok := inFlight[key]; ok {
				return h
			}
		}
	}
	return nil
}

// Writing reports that a write for remote, a bridgev2 remote event (or nil), is starting. The
// function it returns reports how the write ended: err, and whether it was one of the event's
// own (own), not one on the side.
func Writing(remote any) (ended func(err error, own bool)) {
	h := find(remote)
	if h == nil {
		return func(error, bool) {}
	}
	h.update(func(s *State) { s.Running++ })
	return func(err error, own bool) {
		h.update(func(s *State) {
			s.Running--
			if err != nil {
				s.Failed = true
			} else if own {
				s.Done = true
			}
		})
	}
}

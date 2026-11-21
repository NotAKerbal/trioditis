// Package handled lets a network's event handler learn that bridgev2's handling of one of its
// incoming events has got as far as the bridge host's journal.
//
// bridgev2 stops waiting for a handler after its handler limit (5 minutes) and reports
// success while the handler carries on in the background. A network that acknowledges an
// event once its handler returns (WhatsApp) would then acknowledge a message that isn't
// journaled yet, and lose it if the process stopped before it was. The network's handler
// marks the event as in flight (Begin), the connector reports each part bridgev2 hands it for
// that event (Journaled), and the handler waits for that before acknowledging.
package handled

import (
	"sync"
)

// Handling is one incoming event whose handler is waiting to learn it was journaled.
type Handling struct {
	key   any
	noted chan struct{}
}

// Noted receives once for each run of parts journaled since it last did: a send means at
// least one part of the event reached the journal.
func (h *Handling) Noted() <-chan struct{} { return h.noted }

// End stops watching the event. Parts journaled after it are not reported.
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
	h := &Handling{key: key, noted: make(chan struct{}, 1)}
	lock.Lock()
	defer lock.Unlock()
	inFlight[key] = h
	return h
}

// Journaled reports that bridgev2's handling of remote, a bridgev2 remote event (or nil),
// has had a part journaled.
func Journaled(remote any) {
	if remote == nil {
		return
	}
	lock.Lock()
	defer lock.Unlock()
	for _, keyer := range keyers {
		key := keyer(remote)
		if key == nil {
			continue
		}
		if h, ok := inFlight[key]; ok {
			select {
			case h.noted <- struct{}{}:
			default:
			}
		}
	}
}

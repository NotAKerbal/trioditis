// Package handled lets a network's event handler learn how bridgev2's handling of one of its
// incoming events really ended.
//
// bridgev2 stops waiting for a handler after its handler limit (5 minutes) and reports
// success while the handler carries on in the background. A network that acknowledges an
// event once its handler returns (WhatsApp, Signal) would then acknowledge a message that
// isn't journaled yet, and lose it if the process stopped before it was. The network's handler
// marks the event as in flight (Begin); the bridge host's patched bridgev2
// (third_party/mautrix.patch, RemoteEventDone) reports the handler's real outcome (Finished),
// and the network's handler waits for that before acknowledging (Acker). The connector notes
// each message part it journals for the event (NoteMessage), so a handling that failed part
// way can be undone and bridged whole when the network sends the message again.
package handled

import (
	"sync"
)

// Message names a message by its login and network message ID, as bridgev2 keeps its parts.
type Message struct{ Receiver, ID string }

// Handling is one incoming event whose handler may wait for its real outcome.
type Handling struct {
	key      any
	finished chan struct{}

	lock      sync.Mutex
	done      bool
	succeeded bool
	messages  []Message
}

// Finished is closed once bridgev2's handling of the event ended.
func (h *Handling) Finished() <-chan struct{} { return h.finished }

// Succeeded is whether that handling succeeded; false until it ended.
func (h *Handling) Succeeded() bool {
	h.lock.Lock()
	defer h.lock.Unlock()
	return h.done && h.succeeded
}

// End stops waiting on the event. One whose handling hasn't ended yet stays watched until it
// does, so a handling that fails after its handler gave up waiting still has its messages
// undone (Finished).
func (h *Handling) End() {
	h.lock.Lock()
	done := h.done
	h.lock.Unlock()
	if done {
		forget(h)
	}
}

// Forget stops watching the event at once: its handling ended with the handler, or will never
// be reported.
func (h *Handling) Forget() { forget(h) }

func forget(h *Handling) {
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
	h := &Handling{key: key, finished: make(chan struct{})}
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

// NoteMessage records that a part of message is being journaled for remote, a bridgev2 remote
// event. It reports whether a handler is watching the event: only then can the message be
// redelivered, and only then is it worth recording.
func NoteMessage(remote any, message Message) bool {
	h := find(remote)
	if h == nil {
		return false
	}
	h.lock.Lock()
	defer h.lock.Unlock()
	for _, m := range h.messages {
		if m == message {
			return true
		}
	}
	h.messages = append(h.messages, message)
	return true
}

// Finished reports how bridgev2's handling of remote ended, and returns the messages noted for
// it, and whether a handler was watching it.
func Finished(remote any, succeeded bool) ([]Message, bool) {
	h := find(remote)
	if h == nil {
		return nil, false
	}
	h.lock.Lock()
	if !h.done {
		h.done, h.succeeded = true, succeeded
		close(h.finished)
	}
	messages := append([]Message(nil), h.messages...)
	h.lock.Unlock()
	// The handler may have stopped waiting already; nothing more comes for this event.
	forget(h)
	return messages, true
}

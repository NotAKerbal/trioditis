package connector

import (
	"sync"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// messageLocks serializes the attempts at one message (by login and network message ID): an
// attempt holds its message from the start of handling until its outcome is reported and its
// in-flight record settled (remoteEventDone). A redelivery that arrives while an earlier
// attempt is still bridging the message in the background waits, and is then handled against
// what that attempt left: all of it saved (a duplicate, as bridgev2 takes it), or none of it
// (undone, so bridged whole). Without that, bridgev2 could read the first attempt's partial
// parts, take the redelivery for a duplicate, and have it acknowledged before the first
// attempt failed and took its parts back; WhatsApp's duplicate path doesn't even say it was
// one (an upsert answers plain success).
type messageLocks struct {
	lock  sync.Mutex
	held  map[store.InflightMessage]*messageLock
	byEvt sync.Map // bridgev2.RemoteEvent → store.InflightMessage
}

type messageLock struct {
	mu      sync.Mutex
	waiters int
}

// start holds evt's message, if it brings one a network handler is watching (only those can
// be redelivered), until done.
func (l *messageLocks) start(evt bridgev2.RemoteEvent) {
	m, ok := remoteMessage(evt)
	if !ok {
		return
	}
	if _, watched := handled.Messages(evt); !watched {
		return
	}
	l.lock.Lock()
	if l.held == nil {
		l.held = make(map[store.InflightMessage]*messageLock)
	}
	ml := l.held[m]
	if ml == nil {
		ml = &messageLock{}
		l.held[m] = ml
	}
	ml.waiters++
	l.lock.Unlock()
	ml.mu.Lock()
	l.byEvt.Store(evt, m)
}

// done lets the next attempt at evt's message go, if start held it.
func (l *messageLocks) done(evt bridgev2.RemoteEvent) {
	raw, ok := l.byEvt.LoadAndDelete(evt)
	if !ok {
		return
	}
	m := raw.(store.InflightMessage)
	l.lock.Lock()
	ml := l.held[m]
	ml.waiters--
	if ml.waiters == 0 {
		delete(l.held, m)
	}
	l.lock.Unlock()
	ml.mu.Unlock()
}

package gateway

import (
	"context"
	"sync"
	"time"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// Backpressure: when the server is slow to take events, the host lets it catch up rather than
// keep piling history onto it. Every delivery is a Convex mutation that wakes the live queries
// reading what it wrote, so a burst of backfill on a small server starves the people using it,
// whose queries time out. The pusher paces its own deliveries while they're slow, and history
// the backfill queue fetches waits (WaitForRoom) while the server is behind.
const (
	// SlowPush is a delivery slow enough that the next one waits as long again first.
	SlowPush = time.Second
	// maxPace bounds that wait, so live events are never held up long.
	maxPace = 10 * time.Second
	// BacklogHigh is the most unacknowledged journal events before history waits.
	BacklogHigh = 300
	// failureMemory is how long a failed delivery keeps history waiting, and counts.
	failureMemory = 5 * time.Minute
	// strainAfterFailure is how long after a failed delivery the server still counts as behind.
	strainAfterFailure = 30 * time.Second
	// MaxHistoryWait bounds how long one batch of history waits, so a host whose gateway is
	// gone for good still makes progress, slowly.
	MaxHistoryWait = 2 * time.Minute
)

// pressure is what the pusher has seen of the gateway lately.
type pressure struct {
	mu        sync.Mutex
	backlog   int64
	lastPush  time.Duration
	failures  []time.Time
	lastFails time.Time
	// changed is closed and replaced whenever any of it changes, to wake whoever waits.
	changed chan struct{}
}

func (p *pressure) notifyLocked() {
	if p.changed != nil {
		close(p.changed)
	}
	p.changed = make(chan struct{})
}

func (p *pressure) pushed(took time.Duration, backlog int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastPush, p.backlog = took, max(backlog, 0)
	p.notifyLocked()
}

func (p *pressure) failed(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failures = append(p.failures, now)
	p.lastFails = now
	p.notifyLocked()
}

// snapshot is the counts sent with each batch.
func (p *pressure) snapshot(now time.Time) *protocol.Pressure {
	p.mu.Lock()
	defer p.mu.Unlock()
	kept := p.failures[:0]
	for _, at := range p.failures {
		if now.Sub(at) < failureMemory {
			kept = append(kept, at)
		}
	}
	p.failures = kept
	return &protocol.Pressure{Backlog: p.backlog, PushMs: p.lastPush.Milliseconds(), FailedPushes: len(p.failures)}
}

// strained reports whether the server is behind, and a channel that closes when that may change.
func (p *pressure) strained(now time.Time) (bool, <-chan struct{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.changed == nil {
		p.changed = make(chan struct{})
	}
	behind := p.backlog > BacklogHigh || p.lastPush > 2*SlowPush ||
		(!p.lastFails.IsZero() && now.Sub(p.lastFails) < strainAfterFailure)
	return behind, p.changed
}

// lastTook is how long the last answered delivery took.
func (p *pressure) lastTook() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastPush
}

// pace is how long to wait after a delivery that took this long before the next.
func pace(took time.Duration) time.Duration {
	if took < SlowPush {
		return 0
	}
	return min(took, maxPace)
}

// WaitForRoom blocks while the server is behind on this host's events, for at most
// MaxHistoryWait, and reports how long it waited. The backfill queue calls it (through the
// connector) before journaling a batch of history, so history waits for the server and live
// messages don't wait behind it.
func (p *Pusher) WaitForRoom(ctx context.Context) time.Duration {
	start := time.Now()
	deadline := time.NewTimer(MaxHistoryWait)
	defer deadline.Stop()
	for {
		behind, changed := p.pressure.strained(time.Now())
		if !behind {
			return time.Since(start)
		}
		// Checked again at least every few seconds: a failure stops counting as time passes.
		tick := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			tick.Stop()
			return time.Since(start)
		case <-deadline.C:
			tick.Stop()
			return time.Since(start)
		case <-changed:
		case <-tick.C:
		}
		tick.Stop()
	}
}

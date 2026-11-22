package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// A slow answer is the server struggling: the next delivery waits as long again, within bounds.
func TestSlowDeliveriesArePaced(t *testing.T) {
	for _, c := range []struct{ took, want time.Duration }{
		{200 * time.Millisecond, 0},
		{1500 * time.Millisecond, 1500 * time.Millisecond},
		{40 * time.Second, maxPace},
	} {
		if got := pace(c.took); got != c.want {
			t.Errorf("pace(%v) = %v, want %v", c.took, got, c.want)
		}
	}
}

// History waits while the server is behind: a backlog, slow answers, or a failure just now.
func TestTheServerIsBehindWhileDeliveriesStruggle(t *testing.T) {
	now := time.Now()
	var p pressure
	if behind, _ := p.strained(now); behind {
		t.Fatal("a host that has sent nothing isn't behind")
	}
	p.pushed(100*time.Millisecond, BacklogHigh+1)
	if behind, _ := p.strained(now); !behind {
		t.Fatal("a backlog over the limit is behind")
	}
	p.pushed(3*SlowPush, 0)
	if behind, _ := p.strained(now); !behind {
		t.Fatal("slow answers are behind")
	}
	p.pushed(100*time.Millisecond, 0)
	p.failed(now)
	if behind, _ := p.strained(now); !behind {
		t.Fatal("a failure just now is behind")
	}
	if behind, _ := p.strained(now.Add(strainAfterFailure)); behind {
		t.Fatal("a failure long ago, with deliveries going since, isn't")
	}
}

// What the host reports counts failures for five minutes, and nothing else about them.
func TestPressureCountsRecentFailures(t *testing.T) {
	now := time.Now()
	var p pressure
	p.failed(now.Add(-failureMemory - time.Second))
	p.failed(now.Add(-time.Minute))
	p.pushed(1234*time.Millisecond, 42)
	got := p.snapshot(now)
	if got.FailedPushes != 1 || got.Backlog != 42 || got.PushMs != 1234 {
		t.Fatalf("snapshot %+v", got)
	}
}

// Each batch says how deliveries are going, as counts.
func TestABatchCarriesPressure(t *testing.T) {
	p := &Pusher{Log: zerolog.Nop()}
	p.pressure.pushed(250*time.Millisecond, 7)
	raw, _ := json.Marshal(p.batch(nil))
	if !strings.Contains(string(raw), `"pressure":{"backlog":7,"pushMs":250,"failedPushes":0}`) {
		t.Fatalf("batch %s", raw)
	}
}

// History waiting for room goes on as soon as the server has caught up.
func TestHistoryGoesOnOnceTheServerCatchesUp(t *testing.T) {
	p := &Pusher{Log: zerolog.Nop()}
	p.pressure.pushed(100*time.Millisecond, BacklogHigh+50)
	done := make(chan time.Duration, 1)
	go func() { done <- p.WaitForRoom(context.Background()) }()
	select {
	case <-done:
		t.Fatal("history went on while the server was behind")
	case <-time.After(50 * time.Millisecond):
	}
	p.pressure.pushed(100*time.Millisecond, 10)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("history kept waiting once the server caught up")
	}
}

// Nor does it wait past the end of its context.
func TestHistoryStopsWaitingWhenCancelled(t *testing.T) {
	p := &Pusher{Log: zerolog.Nop()}
	p.pressure.pushed(100*time.Millisecond, BacklogHigh+50)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if waited := p.WaitForRoom(ctx); waited > time.Second {
		t.Fatalf("waited %v", waited)
	}
}

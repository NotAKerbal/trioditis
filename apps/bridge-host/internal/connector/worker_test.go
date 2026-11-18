package connector

import (
	"testing"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

func queuedCommand(id, portal string) *store.QueuedCommand {
	return &store.QueuedCommand{Command: &protocol.Command{CommandID: id, PortalID: portal}}
}

// Three commands for one chat: only the first is a candidate, so the third can never start
// ahead of the second, however the first's lane finishes during the pass.
func TestCandidatesKeepOrderWithinAChat(t *testing.T) {
	queued := []*store.QueuedCommand{
		queuedCommand("a1", "p_a"),
		queuedCommand("login", ""),
		queuedCommand("a2", "p_a"),
		queuedCommand("b1", "p_b"),
		queuedCommand("a3", "p_a"),
		queuedCommand("b2", "p_b"),
	}
	var got []string
	for _, cmd := range candidates(queued) {
		got = append(got, cmd.CommandID)
	}
	want := []string{"a1", "login", "b1"}
	if len(got) != len(want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("candidates = %v, want %v", got, want)
		}
	}
}

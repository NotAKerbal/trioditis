package host

import (
	"context"
	"testing"
	"time"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// An account a cancelled login connected, kept while a retry was going, is still logged out
// after a restart: the decision is kept in the store, and made at start once the logins are
// loaded (every login in progress then is over).
func TestACancelledLoginsAccountIsLoggedOutAfterARestart(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	loginID := h.login("alice", "alice-cancelled")
	ctx := context.Background()
	// What a cancelled session that completed late, while a retry was going, leaves kept: the
	// account is that session's activation, and its logout is waiting.
	if err := h.host.Store.PutActivation(ctx, "alice-cancelled", store.Activation{SessionID: "session-gone", UserID: "alice"}); err != nil {
		t.Fatal(err)
	}
	if err := h.host.Store.PutDiscarded(ctx, store.DiscardedLogin{SessionID: "session-gone", UserID: "alice", LoginID: "alice-cancelled"}); err != nil {
		t.Fatal(err)
	}
	h.host.Stop()

	h2 := startHost(t, dir, gw)
	defer h2.host.Stop()
	gw.waitFor(t, "the account logged out", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginState && e.LoginID == loginID && e.State == "LOGGED_OUT"
	})
	// The record goes once the logout has returned, just after it reports the state.
	deadline := time.Now().Add(10 * time.Second)
	for {
		kept, err := h2.host.Store.Discarded(ctx)
		if err == nil && len(kept) == 0 {
			break
		} else if time.Now().After(deadline) {
			t.Fatalf("decided, but still kept: %v %v", kept, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

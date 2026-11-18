package connector

import (
	"context"
	"errors"
	"testing"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// An explicit backfill would let WhatsApp's connector delete history rows outside the range
// asked for, so it is refused for WhatsApp before anything is fetched.
func TestBackfillRefusedWhereTheConnectorPrunes(t *testing.T) {
	c := New(Options{Network: "whatsapp"})
	err := c.Prepare(context.Background(), &protocol.Command{
		CommandID: "c1", Type: protocol.CommandBackfill, UserID: "alice", LoginID: "l_x", PortalID: "p_x", Limit: 50,
	})
	var cmdErr *CommandError
	if !errors.As(err, &cmdErr) || cmdErr.Code != protocol.ErrUnsupported {
		t.Fatalf("expected an unsupported refusal, got %v", err)
	}
}

package connector

import (
	"context"
	"errors"
	"testing"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// Only networks whose contact IDs can be phone numbers sync them; no network's own contact list
// is used, since each connector's reaches past the login that asks.
func TestContactSyncRefusedWhereIDsArentNumbers(t *testing.T) {
	for _, network := range []string{"telegram", "signal", "gmessages", "groupme", "meta"} {
		err := New(Options{Network: network}).Prepare(context.Background(), &protocol.Command{
			CommandID: "c1", Type: protocol.CommandSyncContacts, UserID: "alice", LoginID: "l_x",
		})
		var cmdErr *CommandError
		if !errors.As(err, &cmdErr) || cmdErr.Code != protocol.ErrUnsupported {
			t.Fatalf("%s: expected an unsupported refusal, got %v", network, err)
		}
	}
}

func TestNumbersComeOnlyFromPhoneNumberIDs(t *testing.T) {
	for ghost, want := range map[string]string{
		"15551234567":      "tel:+15551234567",
		"lid-123456789":    "",
		"bot-1313":         "",
		"123":              "",
		"1234567890123456": "",
	} {
		if got := numberID(networkid.UserID(ghost)); got != want {
			t.Errorf("numberID(%q) = %q, want %q", ghost, got, want)
		}
	}
}

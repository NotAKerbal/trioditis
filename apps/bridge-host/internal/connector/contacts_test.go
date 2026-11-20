package connector

import (
	"context"
	"errors"
	"testing"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// A network whose contact list would show one member what another's login knows (Telegram
// changes the shared ghost; WhatsApp fills numbers in from a host-wide map) isn't listed.
func TestContactSyncRefusedWhereTheListIsntPrivate(t *testing.T) {
	for _, network := range []string{"telegram", "meta", "slack"} {
		err := New(Options{Network: network}).Prepare(context.Background(), &protocol.Command{
			CommandID: "c1", Type: protocol.CommandSyncContacts, UserID: "alice", LoginID: "l_x",
		})
		var cmdErr *CommandError
		if !errors.As(err, &cmdErr) || cmdErr.Code != protocol.ErrUnsupported {
			t.Fatalf("%s: expected an unsupported refusal, got %v", network, err)
		}
	}
}

func TestWhatsAppNumbersComeOnlyFromPhoneNumberIDs(t *testing.T) {
	for ghost, want := range map[string]string{
		"15551234567":      "tel:+15551234567",
		"lid-123456789":    "",
		"bot-1313":         "",
		"123":              "",
		"1234567890123456": "",
	} {
		if got := whatsAppNumber(networkid.UserID(ghost)); got != want {
			t.Errorf("whatsAppNumber(%q) = %q, want %q", ghost, got, want)
		}
	}
}

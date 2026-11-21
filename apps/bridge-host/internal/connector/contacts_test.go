package connector

import (
	"context"
	"errors"
	"testing"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
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

// A chat starts only from what each network's connector resolves safely (startTargets).
func TestStartChatRefusedWhereTheConnectorCant(t *testing.T) {
	sealed := &seal.Envelope{V: 1}
	for _, tc := range []struct {
		network string
		cmd     protocol.Command
	}{
		{"telegram", protocol.Command{Sealed: sealed}},
		{"instagram", protocol.Command{Sealed: sealed}},
		{"twitter", protocol.Command{GhostID: "g_x"}},
		{"gvoice", protocol.Command{GhostID: "g_x"}},
		{"gvoice", protocol.Command{Sealed: sealed}},
	} {
		cmd := tc.cmd
		cmd.CommandID, cmd.Type, cmd.UserID, cmd.LoginID, cmd.RequestID = "c1", protocol.CommandStartChat, "alice", "l_x", "request-0000000001"
		err := New(Options{Network: tc.network}).Prepare(context.Background(), &cmd)
		var cmdErr *CommandError
		if !errors.As(err, &cmdErr) || cmdErr.Code != protocol.ErrUnsupported {
			t.Errorf("%s %+v: expected an unsupported refusal, got %v", tc.network, tc.cmd, err)
		}
	}
}

// An identifier reaches the connector only in the form the network takes: a number as digits
// with its +, a username without its @, nothing that could be one of the connector's own IDs.
func TestIdentifiersAreCanonicalForTheirNetwork(t *testing.T) {
	for _, tc := range []struct{ network, in, want string }{
		{"gmessages", "+1 (555) 123-4567", "+15551234567"},
		{"gmessages", "555.123.4567", "5551234567"},
		{"gmessages", "login.participant", ""},
		{"whatsapp", "lid-123456789", ""},
		{"signal", "5551234567", ""},
		{"signal", "+15551234567", "+15551234567"},
		{"signal", "@alice.01", "alice.01"},
		{"signal", "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", ""},
		{"twitter", "@jack", "jack"},
		{"twitter", "+15551234567", ""},
		// Formatting as people type or paste it is taken off before the lookup.
		{"gmessages", "(555) 123-4567", "5551234567"},
		{"whatsapp", "+44 (0)20 7946 0018", "+442079460018"},
		{"whatsapp", "+44 20 7946 0018", "+442079460018"},
		{"whatsapp", "0044 20 7946 0018", "+442079460018"},
		{"whatsapp", "tel:+1-555-123-4567", "+15551234567"},
		{"whatsapp", "+1\u00a0555\u2013123\u20134567", "+15551234567"},
		{"whatsapp", "1 555 123 4567", "15551234567"},
		{"signal", "0044 20 7946 0018", "+442079460018"},
		{"signal", " +1 555 123 4567 ", "+15551234567"},
		// A national number on a network that reads digits as international, or one too short
		// or long to be a number, is written wrong rather than nobody's.
		{"whatsapp", "020 7946 0018", ""},
		{"whatsapp", "+1 555", ""},
		{"whatsapp", "+1234567890123456", ""},
		{"gmessages", "+1 555 12a 4567", ""},
		{"gmessages", "1+5551234567", ""},
	} {
		if got := New(Options{Network: tc.network}).canonicalIdentifier(tc.in); got != tc.want {
			t.Errorf("%s %q: got %q, want %q", tc.network, tc.in, got, tc.want)
		}
	}
}

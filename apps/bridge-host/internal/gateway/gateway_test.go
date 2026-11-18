package gateway

import (
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// One event the gateway would refuse as a body must not hold up the journal behind it.
func TestAnEventTooLargeToSendGoesAsAStandIn(t *testing.T) {
	historical := false
	huge := &protocol.Event{
		Seq: 7, Type: protocol.EventMessage, UserID: "u", LoginID: "l", PortalID: "p", EventID: "e",
		Sender: &protocol.SelfSender, Historical: &historical,
		Sealed: &seal.Envelope{V: 1, Nonce: "n", CT: strings.Repeat("A", 2*protocol.MaxEventBytes)},
	}
	p := &Pusher{Log: zerolog.Nop()}
	out := p.capBytes([]*protocol.Event{huge}, MaxBatchBytes)
	if len(out) != 1 || out[0].Seq != 7 || out[0].Sealed != nil {
		t.Fatalf("expected a stand-in for seq 7, got %+v", out)
	}
}

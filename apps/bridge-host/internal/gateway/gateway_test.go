package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

// A host that stops says so, so it isn't shown online for the two minutes its heartbeats
// would take to go stale.
func TestAStoppingHostSendsAStoppingHeartbeat(t *testing.T) {
	got := make(chan protocol.EventBatch, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch protocol.EventBatch
		_ = json.NewDecoder(r.Body).Decode(&batch)
		got <- batch
		_ = json.NewEncoder(w).Encode(protocol.EventBatchResponse{AckedThrough: 0})
	}))
	defer srv.Close()
	p := NewPusher(NewClient(srv.URL, "token"), nil, "host-1", "testnet", "", zerolog.Nop())
	p.sayStopping()
	select {
	case batch := <-got:
		if !batch.Stopping || len(batch.Events) != 0 || batch.HostID != "host-1" {
			t.Fatalf("stopping heartbeat %+v", batch)
		}
	default:
		t.Fatal("no stopping heartbeat was sent")
	}
	raw, _ := json.Marshal(p.batch(nil))
	if strings.Contains(string(raw), "stopping") {
		t.Fatalf("an ordinary heartbeat mustn't say stopping: %s", raw)
	}
}

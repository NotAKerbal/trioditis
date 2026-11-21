package networks

import (
	"testing"
)

func TestWhatsAppAsksForFullHistory(t *testing.T) {
	spec, ok := Lookup("whatsapp")
	if !ok {
		t.Fatal("whatsapp isn't registered")
	}
	conn, err := spec.New()
	if err != nil {
		t.Fatal(err)
	}
	cfg := conn.(*whatsappConnector).Config.HistorySync
	if !cfg.RequestFullSync || !cfg.BackwardsOnDemand {
		t.Errorf("history sync: full sync %v, backwards on demand %v; want both on", cfg.RequestFullSync, cfg.BackwardsOnDemand)
	}
	// The rest still comes from the connector's defaults.
	if cfg.MaxInitialConversations != -1 || cfg.DispatchWait == 0 {
		t.Errorf("history sync defaults not loaded: max initial conversations %d, dispatch wait %v", cfg.MaxInitialConversations, cfg.DispatchWait)
	}
}

package networks

import (
	"net/netip"
	"testing"
)

func TestIMessageConnector(t *testing.T) {
	network, _ := Lookup("imessage")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	// packages/core offers the flow by this ID.
	if !hasLoginFlow(conn, "bluebubbles") {
		t.Fatalf("no bluebubbles flow in %+v", conn.GetLoginFlows())
	}
}

// A Mac on a private network is reachable only where the operator lists it, and never where
// the operator denies.
func TestIMessagePolicy(t *testing.T) {
	policy, err := imessagePolicy("192.168.1.0/24, 100.64.0.0/10", "192.168.1.1")
	if err != nil {
		t.Fatal(err)
	}
	for addr, want := range map[string]bool{"192.168.1.20": true, "100.70.0.1": true, "192.168.1.1": false, "10.0.0.2": false, "203.0.114.7": true} {
		if got := policy.Allows(netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: %v", addr, got)
		}
	}
	if _, err = imessagePolicy("192.168.1.0/33", ""); err == nil {
		t.Error("a bad range was taken")
	}
	t.Setenv("IMESSAGE_MAC_NETWORKS", "nonsense")
	if _, err = registry["imessage"].New(); err == nil {
		t.Error("the connector started with a setting it can't read")
	}
}

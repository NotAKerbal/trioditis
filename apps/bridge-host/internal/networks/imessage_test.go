package networks

import "testing"

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

package networks

import (
	"slices"
	"testing"
)

// Every network the client knows has a bridge host entry, and each one built in makes its
// connector from its defaults. Signal is only built in with -tags libsignal.
func TestEveryNetworkMakesItsConnector(t *testing.T) {
	want := []string{"bluesky", "gmessages", "groupme", "gvoice", "instagram", "linkedin", "meta", "signal", "slack", "telegram", "twitter", "whatsapp"}
	if got := Names(); !slices.Equal(got, want) {
		t.Fatalf("networks: got %v, want %v", got, want)
	}
	// What an operator must supply, since no default can stand in for it.
	setTelegramCredentials(t)
	for _, name := range Names() {
		conn, err := registry[name].New()
		if name == "signal" && !signalBuiltIn {
			if err == nil {
				t.Errorf("signal: built without libsignal, but New didn't say so")
			}
			continue
		}
		if err != nil || conn == nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

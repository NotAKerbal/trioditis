package ids

import (
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2/networkid"
)

// WhatsApp and Signal give a person one reaction per message, with no emoji ID: a changed
// reaction, or one given again after it was taken away, must not look like a replay.
func TestRemoteReactionEventIDTellsReactionsApart(t *testing.T) {
	key := networkid.PortalKey{ID: "chat", Receiver: "login"}
	at := time.UnixMilli(1_700_000_000_000)
	first := RemoteReactionEventID(key, "msg", "", "alice", "", "👍", at)
	if again := RemoteReactionEventID(key, "msg", "", "alice", "", "👍", at); again != first {
		t.Fatal("a redelivered reaction must keep its ID, so it is applied once")
	}
	if changed := RemoteReactionEventID(key, "msg", "", "alice", "", "❤️", at.Add(time.Second)); changed == first {
		t.Fatal("a replacement reaction got the ID of the one it replaced")
	}
	if readded := RemoteReactionEventID(key, "msg", "", "alice", "", "👍", at.Add(time.Minute)); readded == first {
		t.Fatal("a reaction given again got the ID of the one taken away")
	}
	if other := RemoteReactionEventID(key, "msg", "", "bob", "", "👍", at); other == first {
		t.Fatal("two people's reactions share an ID")
	}
	if RemoteReactionEventID(key, "msg", "", "alice", "", "👍", time.Time{}) == first {
		t.Fatal("a reaction without a timestamp collided with one that has one")
	}
}

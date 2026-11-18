package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

func fields(t *testing.T, v any) map[string]json.RawMessage {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]json.RawMessage
	if err = json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func keys(m map[string]json.RawMessage) string {
	var names []string
	for name := range m {
		names = append(names, name)
	}
	return strings.Join(names, ",")
}

var envelope = &seal.Envelope{V: 1, Nonce: "n", CT: "c", Keys: []seal.EnvelopeKey{{KID: "k", SK: "s"}}}

// The gateway checks every event against the backend's validator, which refuses a field it
// doesn't expect and a required field that is missing.
func TestEventJSONHasExactlyItsTypesFields(t *testing.T) {
	historical := false
	msg := fields(t, &Event{
		Type: EventMessage, UserID: "u", LoginID: "l", PortalID: "p", EventID: "e", Sender: &SelfSender,
		Sealed: envelope, Historical: &historical, Key: "stray", State: "stray",
	})
	if _, ok := msg["networkTs"]; !ok {
		t.Fatalf("a message needs networkTs even when it is 0: %s", keys(msg))
	}
	if _, ok := msg["key"]; ok {
		t.Fatal("a message must not carry a reaction key")
	}
	if _, ok := msg["state"]; ok {
		t.Fatal("a message must not carry a login state")
	}
	if len(msg) != 11 {
		t.Fatalf("unexpected message fields: %s", keys(msg))
	}
	removal := fields(t, &Event{Type: EventReactionRemove, UserID: "u", PortalID: "p", TargetEventID: "e", Sender: &Sender{GhostID: "g"}, Key: "k", NetworkTS: 5})
	if _, ok := removal["networkTs"]; ok {
		t.Fatal("a reaction removal has no networkTs")
	}
	if string(removal["sender"]) != `{"ghostId":"g"}` {
		t.Fatalf("sender %s", removal["sender"])
	}
	step := fields(t, &Event{Type: EventLoginStep, UserID: "u", LoginSessionID: "s", Step: &LoginStep{StepID: "1", Type: StepCookies, Cookies: &LoginCookies{URL: "https://example.com"}}})
	if !strings.Contains(string(step["step"]), `"fields":[]`) {
		t.Fatalf("cookie fields must be an array: %s", step["step"])
	}
}

func TestValidateRefusesWhatTheBackendWould(t *testing.T) {
	if err := (&Event{Type: EventMessage, UserID: "u", PortalID: "p", EventID: "e", Sealed: envelope}).Validate(); err == nil {
		t.Fatal("a message without a sender must be refused")
	}
	big := &seal.Envelope{V: 1, Nonce: "n", CT: strings.Repeat("A", 12*1024), Keys: envelope.Keys}
	if err := (&Event{Type: EventChat, UserID: "u", PortalID: "p", Kind: "group", Sealed: big}).Validate(); err == nil {
		t.Fatal("chat metadata over 8 KiB sealed must be refused")
	}
	if err := (&Event{Type: EventChat, UserID: "u", PortalID: "p", Kind: "group", Sealed: envelope}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBareCarriesOnlyTheCommonFields(t *testing.T) {
	bare := fields(t, Bare(&Event{Seq: 3, Type: EventMessage, UserID: "u", LoginID: "l", At: 1, PortalID: "p", Sealed: envelope}))
	if len(bare) != 5 {
		t.Fatalf("a stand-in carries only seq, type, userId, loginId and at: %s", keys(bare))
	}
}

package protocol

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// vectorFile is testdata/event-vectors.json, which packages/backend/scripts/
// write-protocol-schema.ts writes from the backend's validator. The gateway's tests check that
// the backend accepts every valid event and refuses every invalid one.
type vectorFile struct {
	Valid   []vector `json:"valid"`
	Invalid []vector `json:"invalid"`
}

type vector struct {
	Name  string          `json:"name"`
	Event json.RawMessage `json:"event"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile("testdata/event-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors vectorFile
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Valid) == 0 || len(vectors.Invalid) == 0 {
		t.Fatal("no example events")
	}
	return vectors
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

// Every event the backend accepts, the bridge host can hold and send back exactly: a field
// the Go types are missing, or write differently, shows up here.
func TestValidEventsSurviveTheBridgeHost(t *testing.T) {
	for _, v := range loadVectors(t).Valid {
		var evt Event
		if err := json.Unmarshal(v.Event, &evt); err != nil {
			t.Errorf("%s: %v", v.Name, err)
			continue
		}
		if err := evt.Validate(); err != nil {
			t.Errorf("%s: refused: %v", v.Name, err)
			continue
		}
		out, err := json.Marshal(&evt)
		if err != nil {
			t.Fatal(err)
		}
		if !sameJSON(t, out, v.Event) {
			t.Errorf("%s: sent as\n%s\nnot\n%s", v.Name, out, v.Event)
		}
		if err = CheckShape(out); err != nil {
			t.Errorf("%s: %v", v.Name, err)
		}
	}
}

// What the backend refuses, the bridge host either refuses to journal or sends in a shape the
// backend accepts (a missing number written as 0, say, or a field it doesn't have dropped).
func TestInvalidEventsAreNeverSent(t *testing.T) {
	for _, v := range loadVectors(t).Invalid {
		var evt Event
		if err := json.Unmarshal(v.Event, &evt); err != nil {
			continue // the Go types can't even hold it
		}
		if evt.Validate() != nil {
			continue
		}
		out, err := json.Marshal(&evt)
		if err != nil {
			t.Fatal(err)
		}
		if err = CheckShape(out); err != nil {
			t.Errorf("%s: passed Validate, then sent as %s: %v", v.Name, out, err)
		}
	}
}

// The bridge host names every event type the backend has, and no other: a type added on
// one side only fails here.
func TestEveryEventTypeIsTheBackendsToo(t *testing.T) {
	ours := []string{
		EventMessage, EventEdit, EventReaction, EventReactionRemove, EventRedaction, EventReceipt, EventTyping,
		EventChat, EventContact, EventContactIdentifiers, EventChatCollage, EventChatStarted, EventLoginState,
		EventLoginStep, EventSendStatus, EventBackfillDone,
	}
	var theirs []string
	for name := range schema.Events {
		theirs = append(theirs, name)
	}
	slices.Sort(ours)
	slices.Sort(theirs)
	if !slices.Equal(ours, theirs) {
		t.Fatalf("bridge host has %v, backend has %v", ours, theirs)
	}
}

// Validate refuses sealed content over the schema's limit for its type, and the connector,
// which cuts content down to MaxMessageSealedBytes or MaxMetadataSealedBytes before sealing,
// cuts it to the backend's limits.
func TestSealedLimitsAreTheBackends(t *testing.T) {
	full := map[string]json.RawMessage{}
	for _, v := range loadVectors(t).Valid {
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(v.Event, &head)
		if _, ok := full[head.Type]; !ok {
			full[head.Type] = v.Event
		}
	}
	for name, shape := range schema.Events {
		if shape.MaxSealedBytes == 0 {
			if slices.Contains(shape.Required, "sealed") || slices.Contains(shape.Optional, "sealed") {
				t.Errorf("%s carries sealed content with no limit", name)
			}
			continue
		}
		want := MaxMetadataSealedBytes
		if name == EventMessage || name == EventEdit {
			want = MaxMessageSealedBytes
		}
		if shape.MaxSealedBytes != want {
			t.Errorf("%s: backend allows %d sealed bytes, the connector cuts content to %d", name, shape.MaxSealedBytes, want)
		}
		for size, ok := range map[int]bool{shape.MaxSealedBytes: true, shape.MaxSealedBytes + 1: false} {
			var evt Event
			if err := json.Unmarshal(full[name], &evt); err != nil {
				t.Fatal(err)
			}
			evt.Sealed = &seal.Envelope{V: 1, Nonce: "n", CT: seal.Encode(make([]byte, size)), Keys: envelope.Keys}
			if err := evt.Validate(); (err == nil) != ok {
				t.Errorf("%s with %d sealed bytes: %v", name, size, err)
			}
		}
	}
}

func TestCheckShapeRefusesWhatTheGatewayWould(t *testing.T) {
	for _, body := range []string{
		`{"seq":1,"type":"receipt","userId":"u","loginId":"l","at":1,"portalId":"p","sender":{"self":true},"upToEventId":"e"}`,
		`{"seq":1,"type":"typing","userId":"u","loginId":"l","at":1,"portalId":"p","sender":{"self":true},"typing":true,"timeoutMs":1,"body":"hi"}`,
		`{"seq":1,"type":"nope","userId":"u","loginId":"l","at":1}`,
		`{"type":"backfillDone","userId":"u","loginId":"l","at":1,"portalId":"p","direction":"forward","more":false}`,
	} {
		if CheckShape([]byte(body)) == nil {
			t.Errorf("accepted %s", body)
		}
	}
}

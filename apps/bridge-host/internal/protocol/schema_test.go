package protocol

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
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

// constants are the string constants protocol.go declares whose names start with prefix.
func constants(t *testing.T, prefix string) []string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "protocol.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			value := spec.(*ast.ValueSpec)
			for i, name := range value.Names {
				if !strings.HasPrefix(name.Name, prefix) || i >= len(value.Values) {
					continue
				}
				if lit, ok := value.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
					text, _ := strconv.Unquote(lit.Value)
					out = append(out, text)
				}
			}
		}
	}
	slices.Sort(out)
	return out
}

func sorted(values []any) []string {
	var out []string
	for _, value := range values {
		out = append(out, fmt.Sprint(value))
	}
	slices.Sort(out)
	return out
}

// The event types, send statuses, error codes and login step types the bridge host declares
// are exactly the backend's: one added or dropped on either side alone fails here.
func TestTheBridgeHostsValuesAreTheBackends(t *testing.T) {
	var types []any
	for name := range schema.Events {
		types = append(types, name)
	}
	for _, c := range []struct {
		prefix string
		theirs []any
	}{
		{"Event", types},
		{"Status", schema.Events[EventSendStatus].Values["status"]},
		{"Err", schema.Events[EventSendStatus].Values["error"]},
		{"Step", schema.Events[EventLoginStep].Values["step.type"]},
	} {
		if ours, theirs := constants(t, c.prefix), sorted(c.theirs); !slices.Equal(ours, theirs) {
			t.Errorf("%s constants: bridge host has %v, backend has %v", c.prefix, ours, theirs)
		}
	}
	// Every error field takes the same codes.
	for name, shape := range schema.Events {
		for path, values := range shape.Values {
			if path == "error" || strings.HasSuffix(path, ".error") {
				if ours, theirs := constants(t, "Err"), sorted(values); !slices.Equal(ours, theirs) {
					t.Errorf("%s %s: bridge host has %v, backend has %v", name, path, ours, theirs)
				}
			}
		}
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
			// Sealed content a caller attached to a type that has none is never sent, but is still
			// refused over the message limit, as before the schema.
			var evt Event
			if err := json.Unmarshal(full[name], &evt); err != nil {
				t.Fatal(err)
			}
			evt.Sealed = &seal.Envelope{V: 1, Nonce: "n", CT: seal.Encode(make([]byte, MaxMessageSealedBytes+1)), Keys: envelope.Keys}
			if evt.Validate() == nil {
				t.Errorf("%s with %d sealed bytes attached was accepted", name, MaxMessageSealedBytes+1)
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
		`{"seq":1,"type":"backfillDone","userId":"u","loginId":"l","at":1,"portalId":"p","direction":"sideways","more":false}`,
		`{"seq":1,"type":"sendStatus","userId":"u","loginId":"l","at":1,"clientMessageId":"c","status":{"sent":true}}`,
		`{"seq":1,"type":"loginStep","userId":"u","loginId":"l","at":1,"loginSessionId":"s","step":{"stepId":"1","type":"done"}}`,
	} {
		if CheckShape([]byte(body)) == nil {
			t.Errorf("accepted %s", body)
		}
	}
}

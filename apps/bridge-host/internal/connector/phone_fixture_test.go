package connector

import (
	"encoding/json"
	"os"
	"testing"
)

// The client reads a typed number the same way before it sends one (packages/core,
// normalPhone and startIdentifier). Both sides check the same table, so the app never offers a
// number the bridge host would refuse, or sends one in a shape the host reads differently.
func TestPhoneNumbersMatchTheClient(t *testing.T) {
	data, err := os.ReadFile("../../../../packages/core/test/fixtures/phone-identifiers.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		NormalPhone     [][2]*string `json:"normalPhone"`
		StartIdentifier [][3]*string `json:"startIdentifier"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.NormalPhone) == 0 || len(fixture.StartIdentifier) == 0 {
		t.Fatal("the fixture has no cases")
	}
	value := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	for _, tc := range fixture.NormalPhone {
		if got, want := normalPhone(*tc[0]), value(tc[1]); got != want {
			t.Errorf("normalPhone(%q) = %q, want %q", *tc[0], got, want)
		}
	}
	for _, tc := range fixture.StartIdentifier {
		network, in, want := *tc[0], *tc[1], value(tc[2])
		if got := New(Options{Network: network}).canonicalIdentifier(in); got != want {
			t.Errorf("%s %q: got %q, want %q", network, in, got, want)
		}
	}
}

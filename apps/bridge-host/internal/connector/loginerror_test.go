package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
)

// A failed login's log line lists what its error is made of, in errors.Is order, with the
// mautrix codes among them, and none of the error's text.
func TestDescribeLoginError(t *testing.T) {
	start := bridgev2.RespError(mautrix.MUnknown.WithMessage("Failed to start login"))
	inner := errors.New("what the person typed")
	err := fmt.Errorf("%w: %w", start, fmt.Errorf("failed to fetch config: %w", inner))

	var buf bytes.Buffer
	log := zerolog.New(&buf)
	(&Connector{}).describeLoginError(log.Warn(), err).Msg("Login failed")

	if bytes.Contains(buf.Bytes(), []byte("typed")) || bytes.Contains(buf.Bytes(), []byte("Failed to start")) {
		t.Fatalf("the log line has the error's text: %s", buf.String())
	}
	var line struct {
		Type  string   `json:"error_type"`
		Chain []string `json:"error_chain"`
		Codes []string `json:"error_codes"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line.Type != "*fmt.wrapErrors" {
		t.Errorf("error_type: %q", line.Type)
	}
	want := []string{"*fmt.wrapErrors", "bridgev2.RespError", "*fmt.wrapError", "*errors.errorString"}
	if !slices.Equal(line.Chain, want) {
		t.Errorf("error_chain: got %v, want %v", line.Chain, want)
	}
	if !slices.Equal(line.Codes, []string{"M_UNKNOWN"}) {
		t.Errorf("error_codes: %v", line.Codes)
	}
}

// A chain is listed only so far, however long it is.
func TestDescribeLoginErrorCapsTheChain(t *testing.T) {
	err := errors.New("bottom")
	for range 100 {
		err = fmt.Errorf("up: %w", err)
	}
	var buf bytes.Buffer
	log := zerolog.New(&buf)
	(&Connector{}).describeLoginError(log.Warn(), err).Send()
	var line struct {
		Chain []string `json:"error_chain"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if len(line.Chain) != maxErrorChain {
		t.Errorf("error_chain has %d entries, want %d", len(line.Chain), maxErrorChain)
	}
}

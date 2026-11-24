package connector

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

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

// cyclic wraps itself, as no real error does.
type cyclic struct{}

func (c *cyclic) Error() string { return "cyclic" }
func (c *cyclic) Unwrap() error { return c }

// panicky panics when unwrapped.
type panicky struct{}

func (panicky) Error() string { return "panicky" }
func (panicky) Unwrap() error { panic("unwrap") }

// An odd error never stops the line, and so the login's failure report, from going out.
func TestDescribeLoginErrorOddErrors(t *testing.T) {
	var nilResp *bridgev2.RespError
	for _, err := range []error{&cyclic{}, panicky{}, nilResp, errors.Join(errors.New("x"), nilResp)} {
		var buf bytes.Buffer
		log := zerolog.New(&buf)
		done := make(chan struct{})
		go func() {
			defer close(done)
			(&Connector{}).describeLoginError(log.Warn(), err).Send()
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("describing %T didn't finish", err)
		}
		if !bytes.Contains(buf.Bytes(), []byte(`"error_type"`)) {
			t.Errorf("%T: no error_type in %s", err, buf.String())
		}
	}
}

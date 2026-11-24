package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// A cookie copied from developer tools arrives percent-encoded and reaches the connector
// decoded; one pasted decoded, and fields that aren't cookies, reach it as typed.
func TestDecodeCookies(t *testing.T) {
	params := &bridgev2.LoginCookiesParams{Fields: []bridgev2.LoginCookieField{{
		ID:      "auth_token",
		Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeSpecial, Name: "token"}},
	}, {
		ID:      "cookie_token",
		Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "d"}},
	}, {
		ID:      "decoded",
		Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "x"}},
	}}}
	input := map[string]string{
		"auth_token":   "xoxc-a%2Fb",
		"cookie_token": "xoxd-a%2Fb%2Bc%3D%3D",
		"decoded":      "xoxd-a/b+c==",
	}
	decodeCookies(params, input)
	want := map[string]string{"auth_token": "xoxc-a%2Fb", "cookie_token": "xoxd-a/b+c==", "decoded": "xoxd-a/b+c=="}
	for k, v := range want {
		if input[k] != v {
			t.Errorf("%s: got %q, want %q", k, input[k], v)
		}
	}
	decodeCookies(nil, input)
}

// A paste of a step the sign-in browser already submitted is taken and dropped, however far
// the login has moved on, so it never ends the login the browser is moving along.
func TestPasteAfterBrowserIsDropped(t *testing.T) {
	c := &Connector{}
	c.browserSteps.Store("login-1/step-1", struct{}{})
	cmd := &protocol.Command{Type: protocol.CommandLoginSubmit, LoginSessionID: "login-1", StepID: "step-1", UserID: "u"}
	if err := c.handleLoginSubmit(context.Background(), cmd, false); err != nil {
		t.Fatalf("a paste after the browser: %v", err)
	}
}

// A failed login's log says how long after its last step it failed and which cookies it was
// given, by name only.
func TestDescribeLoginAttempt(t *testing.T) {
	var buf bytes.Buffer
	log := zerolog.New(&buf)
	describeLoginAttempt(log.Warn(), 1234*time.Millisecond, false, []string{"OSID", "SID"}).Msg("Login failed")
	var got struct {
		Since   float64  `json:"since_last_step_seconds"`
		Cookies []string `json:"cookie_fields"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Since != 1.2 || !slices.Equal(got.Cookies, []string{"OSID", "SID"}) {
		t.Fatalf("got %s", buf.String())
	}

	buf.Reset()
	describeLoginAttempt(log.Warn(), 0, true, nil).Msg("Login failed")
	if strings.Contains(buf.String(), "since_last_step_seconds") || strings.Contains(buf.String(), "cookie_fields") {
		t.Fatalf("a login that failed before any step or cookies logged them: %s", buf.String())
	}
}

// Only the step's own cookie fields with a value are named, never another key a pasted
// submission carried.
func TestDeclaredCookieFields(t *testing.T) {
	params := &bridgev2.LoginCookiesParams{Fields: []bridgev2.LoginCookieField{{ID: "SID"}, {ID: "OSID"}, {ID: "__Secure-1PSIDTS"}}}
	input := map[string]string{"SID": "a", "OSID": "b", "__Secure-1PSIDTS": "", "pasted-secret-key": "c"}
	if got := declaredCookieFields(params, input); !slices.Equal(got, []string{"OSID", "SID"}) {
		t.Fatalf("got %v", got)
	}
	if got := declaredCookieFields(nil, input); got != nil {
		t.Fatalf("got %v without a step's fields", got)
	}
}

// cookieKeeper is a login process that keeps the cookies it is given, as mautrix-gmessages
// does, and fails, so the login ends without a store.
type cookieKeeper struct {
	bridgev2.LoginProcess
	kept map[string]string
}

func (p *cookieKeeper) SubmitCookies(_ context.Context, cookies map[string]string) (*bridgev2.LoginStep, error) {
	p.kept = cookies
	return nil, nil
}

// The cookies a connector keeps are still there after the login hands them over: clearing
// the submitted copy mustn't clear the connector's.
func TestSubmittedCookiesStayWithTheConnector(t *testing.T) {
	proc := &cookieKeeper{}
	step := &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeCookies, CookiesParams: &bridgev2.LoginCookiesParams{
		Fields: []bridgev2.LoginCookieField{{ID: "SID"}},
	}}
	s := &loginSession{c: &Connector{}, process: proc, ctx: context.Background(), done: true}
	input := map[string]string{"SID": "value"}
	s.submitInput(step, input, true)
	if len(input) != 0 {
		t.Fatalf("the submitted copy wasn't cleared: %v", input)
	}
	if proc.kept["SID"] != "value" {
		t.Fatalf("the connector's cookies were cleared: %v", proc.kept)
	}
}

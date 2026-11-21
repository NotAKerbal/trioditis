package connector

import (
	"context"
	"testing"

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

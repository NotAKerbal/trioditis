package connector

import (
	"testing"

	"maunium.net/go/mautrix/bridgev2"
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

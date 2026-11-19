package networks

import (
	"slices"
	"testing"

	igconnector "go.mau.fi/mautrix-meta/pkg/igconnector"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func TestInstagramConnectorDefaults(t *testing.T) {
	t.Setenv("INSTAGRAM_PROXY", "socks5://127.0.0.1:1080")
	conn, err := registry["instagram"].New()
	if err != nil {
		t.Fatal(err)
	}
	ig := conn.(*igconnector.IGConnector)
	if ig.Config.Proxy != "socks5://127.0.0.1:1080" {
		t.Errorf("proxy: got %q", ig.Config.Proxy)
	}
	if got := ig.Config.FormatDisplayname(igconnector.DisplaynameParams{Username: "someone"}); got != "someone" {
		t.Errorf("display name template from the defaults: got %q", got)
	}
	var flows []string
	for _, flow := range ig.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	// packages/core's NETWORK_INFO offers only the cookie flow.
	if want := []string{"android", "instagram", "instagram-password"}; !slices.Equal(flows, want) {
		t.Errorf("login flows: got %v, want %v", flows, want)
	}
	t.Setenv("INSTAGRAM_PROXY", "not a url")
	if _, err = registry["instagram"].New(); err == nil {
		t.Error("a proxy that isn't a URL was accepted")
	}
}

// The cookie flow starts through the bridge host and asks for Instagram's three session
// cookies, with the routing cookies optional; missing required ones end the login without
// reaching Instagram.
func TestInstagramCookieLoginStarts(t *testing.T) {
	m := startMetaHost(t, "instagram")
	step := m.startLogin("alice", "session-cookies", "instagram")
	if step.Type != protocol.StepCookies || step.Cookies == nil {
		t.Fatalf("first step is %s, not cookies", step.Type)
	}
	if step.Cookies.URL != "https://www.instagram.com/accounts/login/" {
		t.Errorf("URL %q", step.Cookies.URL)
	}
	required, optional := cookieFields(step)
	if want := []string{"sessionid", "csrftoken", "ds_user_id"}; !slices.Equal(required, want) {
		t.Errorf("required cookies %v, want %v", required, want)
	}
	if want := []string{"rur", "shbid", "shbts", "mid", "ig_did"}; !slices.Equal(optional, want) {
		t.Errorf("optional cookies %v, want %v", optional, want)
	}
	end := m.submit("alice", "session-cookies", step, map[string]string{"sessionid": "", "csrftoken": "x", "shbid": ""})
	if end.Type != protocol.StepError || end.Error != protocol.ErrLoginFailed {
		t.Errorf("missing cookies ended with %s %s", end.Type, end.Error)
	}
}

package networks

import (
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	twitter "go.mau.fi/mautrix-twitter/pkg/connector"
	"go.mau.fi/mautrix-twitter/pkg/twittermeow"
	twitterCookies "go.mau.fi/mautrix-twitter/pkg/twittermeow/cookies"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func TestTwitterConnector(t *testing.T) {
	network, _ := Lookup("twitter")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	tw := conn.(*twitter.TwitterConnector)
	if !tw.Config.X || conn.GetName().DisplayName != "X" {
		t.Errorf("the connector calls the network %q", conn.GetName().DisplayName)
	}
	if !tw.Config.CacheSession || tw.Config.ConversationSyncLimit <= 0 {
		t.Errorf("the example config's defaults weren't loaded: %+v", tw.Config)
	}
	if got := tw.Config.FormatDisplayname("ada", "Ada Lovelace"); got != "Ada Lovelace" {
		t.Errorf("contact name %q", got)
	}
	if got := tw.Config.FormatDisplayname("ada", ""); got != "ada" {
		t.Errorf("contact with no display name: %q, want the handle", got)
	}
	// packages/core offers the cookie flow by this ID.
	if !hasLoginFlow(conn, "cookies") {
		t.Fatalf("no cookies flow in %+v", conn.GetLoginFlows())
	}

	h := startSocialHost(t, "twitter", conn)
	step := socialFirstStep(t, h, "twitter", "cookies")
	if step.Type != protocol.StepCookies || step.Cookies == nil || !strings.HasPrefix(step.Cookies.URL, "https://x.com/") {
		t.Fatalf("first step: %+v", step)
	}
	var ids []string
	for _, f := range step.Cookies.Fields {
		if !f.Required {
			t.Errorf("cookie %s isn't required", f.ID)
		}
		ids = append(ids, f.ID)
	}
	if strings.Join(ids, ",") != "ct0,auth_token" {
		t.Errorf("cookie fields %v, want ct0 and auth_token", ids)
	}
}

// Every request to X goes through req's Chrome-impersonating transport, and the bridge host
// builds mautrix-twitter with beeper's req fork at the version mautrix-meta names, newer
// than the one mautrix-twitter pins. This fetches x.com's robots.txt through that transport,
// with no account. It reaches X, so it is skipped with -short and when offline.
func TestTwitterTransportReachesX(t *testing.T) {
	if testing.Short() {
		t.Skip("reaches x.com")
	}
	client := twittermeow.NewClient(twitterCookies.NewCookies(nil), nil, zerolog.Nop())
	resp, err := client.HTTP.Get("https://x.com/robots.txt")
	var dnsErr *net.DNSError
	var opErr *net.OpError
	if errors.As(err, &dnsErr) || (errors.As(err, &opErr) && opErr.Op == "dial") {
		t.Skipf("offline: %v", err)
	} else if err != nil {
		t.Fatal(err)
	}
	// Any answer means the TLS handshake and HTTP exchange worked; what X answers a given
	// address (CI runners included) isn't this test's business.
	_ = resp.Body.Close()
	t.Logf("x.com/robots.txt answered %d over %s", resp.StatusCode, resp.Proto)
}

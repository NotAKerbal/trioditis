package networks

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// startSocialHost runs a bridge host for one network with no gateway, sealing to dev keys
// in a temporary directory, the way `bridge-host --dev-keys login` does.
func startSocialHost(t *testing.T, network string, conn bridgev2.NetworkConnector) *host.Host {
	t.Helper()
	dir := t.TempDir()
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h, err := host.New(host.Config{
		Network:          network,
		DataDir:          dir,
		BridgeKey:        bridgeKey,
		NetworkConnector: conn,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		Log:              zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return h
}

// socialFirstStep starts a login through the same command the gateway sends and returns
// the first step the host reports. The login is cancelled when the test ends.
func socialFirstStep(t *testing.T, h *host.Host, network, flowID string) *protocol.LoginStep {
	t.Helper()
	ctx := context.Background()
	session := "test-" + network + "-" + flowID
	from, err := h.Store.LastSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: "isaac",
		LoginSessionID: session, Network: network, FlowID: flowID,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = h.Connector.HandleCommand(ctx, &protocol.Command{
			CommandID: session + "-cancel", Type: protocol.CommandLoginCancel, UserID: "isaac", LoginSessionID: session,
		})
	})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		events, err := h.Store.After(ctx, from, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range events {
			from = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return evt.Step
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s %s: no login step", network, flowID)
	return nil
}

func hasLoginFlow(conn bridgev2.NetworkConnector, id string) bool {
	return slices.ContainsFunc(conn.GetLoginFlows(), func(f bridgev2.LoginFlow) bool { return f.ID == id })
}

func TestLinkedInConnector(t *testing.T) {
	network, _ := Lookup("linkedin")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	li := conn.(*linkedin.LinkedInConnector)
	if li.Config.LogRedactedLoginResponses {
		t.Error("login responses would be logged")
	}
	if li.Config.Sync.CreateLimit <= 0 {
		t.Errorf("sync create limit %d: the example config's defaults weren't loaded", li.Config.Sync.CreateLimit)
	}
	if got := li.Config.FormatDisplayname(linkedin.DisplaynameParams{FirstName: "Ada", LastName: "Lovelace"}); got != "Ada Lovelace" {
		t.Errorf("contact name %q, want %q", got, "Ada Lovelace")
	}
	if got := li.Config.FormatDisplayname(linkedin.DisplaynameParams{Organization: "Analytical Engines"}); got != "Analytical Engines" {
		t.Errorf("organization name %q", got)
	}
	// packages/core offers the cookie flow by this ID.
	if !hasLoginFlow(conn, "cookies") {
		t.Fatalf("no cookies flow in %+v", conn.GetLoginFlows())
	}

	h := startSocialHost(t, "linkedin", conn)
	step := socialFirstStep(t, h, "linkedin", "cookies")
	if step.Type != protocol.StepCookies || step.Cookies == nil || !strings.HasPrefix(step.Cookies.URL, "https://linkedin.com/") {
		t.Fatalf("first step: %+v", step)
	}
	required := map[string]bool{}
	for _, f := range step.Cookies.Fields {
		required[f.ID] = f.Required
	}
	// The cookie header and the two LinkedIn headers are needed; the browser headers are
	// optional (Firefox sends no Sec-Ch-Ua headers at all), so the app must not insist on them.
	for id, want := range map[string]bool{
		"fi.mau.linkedin.login.cookie_header":             true,
		"fi.mau.linkedin.login.x_li_track":                true,
		"fi.mau.linkedin.login.x_li_page_instance":        true,
		"fi.mau.linkedin.login.header.user-agent":         false,
		"fi.mau.linkedin.login.header.sec-ch-ua":          false,
		"fi.mau.linkedin.login.header.sec-ch-ua-platform": false,
	} {
		if got, ok := required[id]; !ok || got != want {
			t.Errorf("cookie field %s: present %v, required %v, want required %v", id, ok, got, want)
		}
	}
}

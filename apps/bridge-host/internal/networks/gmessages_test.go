package networks

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rs/zerolog"
	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// googleLoginFirstStep starts a network's login through a bridge host the way the gateway
// would (a loginStart command), returns the first step it reports, and cancels the login.
// It needs no account: it stops before anything is submitted.
func googleLoginFirstStep(t *testing.T, network string, conn bridgev2.NetworkConnector, flowID string) *protocol.LoginStep {
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)

	const user, session = "test", "login-1"
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "start", Type: protocol.CommandLoginStart, UserID: user, LoginSessionID: session,
		Network: network, FlowID: flowID,
	}); err != nil {
		t.Fatalf("loginStart: %v", err)
	}
	step := waitForLoginStep(ctx, t, h, session, 0)
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "cancel", Type: protocol.CommandLoginCancel, UserID: user, LoginSessionID: session,
	}); err != nil {
		t.Fatalf("loginCancel: %v", err)
	}
	if last := waitForLoginStep(ctx, t, h, session, step.seq); last.Type != protocol.StepCancelled {
		t.Fatalf("after loginCancel: got a %q step, want cancelled", last.Type)
	}
	return step.LoginStep
}

type journaledStep struct {
	*protocol.LoginStep
	seq int64
}

// waitForLoginStep returns the first step of the login journaled after seq.
func waitForLoginStep(ctx context.Context, t *testing.T, h *host.Host, session string, seq int64) journaledStep {
	t.Helper()
	for {
		events, err := h.Store.After(ctx, seq, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range events {
			seq = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return journaledStep{evt.Step, evt.Seq}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("no login step was journaled")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// The connector's own retry waits, read before any New empties them: proof that the
// linkname reaches the connector's variable rather than a copy of its own.
var gmessagesUpstreamRetries = slices.Clone(gmessagesSendRetryBackoff)

func TestGMessagesConnector(t *testing.T) {
	if len(gmessagesUpstreamRetries) == 0 {
		t.Fatal("gmessagesSendRetryBackoff isn't linked to the connector's sendRetryBackoff")
	}
	conn, err := registry["gmessages"].New()
	if err != nil {
		t.Fatal(err)
	}
	gm := conn.(*gmessages.GMConnector)
	if gm.Config.DeviceMeta.OS != "Trioditis" || gm.Config.DeviceMeta.Type != "TABLET" || gm.Config.DeviceMeta.Browser != "OTHER" {
		t.Errorf("device meta: %+v", gm.Config.DeviceMeta)
	}
	if !gm.Config.AggressiveReconnect {
		t.Error("the bridge must take its session back by itself: Trioditis has no set-active command")
	}
	if gm.Config.InitialChatSyncCount != 25 || gm.Config.PingInterval != 20*time.Minute {
		t.Errorf("example defaults not loaded: %+v", gm.Config)
	}
	// The display name template was parsed from the example config.
	if name := gm.Config.FormatDisplayname("+1 555 0100", "", ""); name != "+1 555 0100" {
		t.Errorf("display name falls back to the phone number: got %q", name)
	}
	if gm.GetCapabilities().OutgoingMessageTimeouts != nil {
		t.Error("bridgev2's echo timeouts would settle slow sends as unknown before the phone confirms them")
	}
	if len(gmessagesSendRetryBackoff) != 0 {
		t.Errorf("the connector would send again after an uncertain failure: %v", gmessagesSendRetryBackoff)
	}
	// packages/core/src/client.ts offers exactly these flow IDs for gmessages.
	var flows []string
	for _, flow := range gm.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	if !slices.Equal(flows, []string{"google"}) {
		t.Errorf("login flows: got %v, want [google]", flows)
	}
}

// The Google account login begins with a cookie step, which needs no account to reach.
func TestGMessagesLoginStartsWithCookies(t *testing.T) {
	conn, err := registry["gmessages"].New()
	if err != nil {
		t.Fatal(err)
	}
	step := googleLoginFirstStep(t, "gmessages", conn, "google")
	if step.Type != protocol.StepCookies || step.Cookies == nil {
		t.Fatalf("first step: got %+v, want cookies", step)
	}
	if step.Cookies.URL != "https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config" {
		t.Errorf("cookie URL: %q", step.Cookies.URL)
	}
	required := map[string]bool{}
	for _, f := range step.Cookies.Fields {
		required[f.ID] = f.Required
	}
	want := map[string]bool{
		"SID": true, "HSID": true, "SSID": true, "APISID": true, "SAPISID": true, "OSID": true,
		"__Secure-1PSIDTS": false,
	}
	if len(required) != len(want) {
		t.Errorf("cookie fields: got %v, want %v", required, want)
	}
	for id, req := range want {
		if got, ok := required[id]; !ok || got != req {
			t.Errorf("cookie %s: present %v, required %v; want required %v", id, ok, got, req)
		}
	}
}

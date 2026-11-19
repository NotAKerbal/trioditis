//go:build libsignal

package networks

import (
	"context"
	"net"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	signal "go.mau.fi/mautrix-signal/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// The connector is made from mautrix-signal's defaults with the bridge host's changes, and
// offers the one login flow packages/core's NETWORK_INFO lists for Signal.
func TestSignalConnectorConfig(t *testing.T) {
	network, _ := Lookup("signal")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	sc := conn.(*signal.SignalConnector)
	if sc.Config.DeviceName != "Trioditis" {
		t.Errorf("device name: got %q", sc.Config.DeviceName)
	}
	if sc.Config.NoteToSelfAvatar != "" {
		t.Errorf("Note to Self avatar: got %q, want none", sc.Config.NoteToSelfAvatar)
	}
	// Contact names and contact avatars from one person's address book stay out of what
	// every person on the host sees of that contact.
	if sc.Config.UseContactAvatars || sc.Config.UseOutdatedProfiles || strings.Contains(sc.Config.DisplaynameTemplate, "ContactName") {
		t.Errorf("contact-book data would be shared between people: %+v", sc.Config)
	}
	var flows []string
	for _, flow := range sc.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	if !slices.Equal(flows, []string{"qr"}) {
		t.Errorf("login flows: got %v, want [qr]", flows)
	}
	if network.Background == nil {
		t.Error("Signal has no background sweep")
	}
	// signalmeow resubmits a send after an ambiguous outcome, so the host must refuse sends.
	if !network.ReceiveOnly {
		t.Error("Signal isn't receive-only")
	}
	if network.LogFilter == nil {
		t.Error("Signal's log isn't filtered")
	}
}

// A login started through the bridge host's commands reaches its first step, a QR code of
// the linking URI Signal's provisioning service hands out, without any account. This talks
// to Signal's servers, so it is skipped with -short and offline.
func TestSignalLoginStartsWithALinkingQR(t *testing.T) {
	if testing.Short() {
		t.Skip("reaches Signal's servers")
	}
	if c, err := net.DialTimeout("tcp", "chat.signal.org:443", 5*time.Second); err != nil {
		t.Skipf("Signal's servers are unreachable: %v", err)
	} else {
		_ = c.Close()
	}
	network, _ := Lookup("signal")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h, err := host.New(host.Config{
		Network: "signal", DataDir: dir, BridgeKey: bridgeKey,
		NetworkConnector: conn,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		Log:              zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err = h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	stopSweep := network.Background(ctx, conn, zerolog.Nop())
	defer func() {
		stopSweep()
		h.Stop()
	}()

	const user, session = "test", "signal-login"
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "start", Type: protocol.CommandLoginStart, UserID: user, LoginSessionID: session, Network: "signal",
	}); err != nil {
		t.Fatal(err)
	}
	step := waitForStep(t, ctx, h, session)
	if step.Type != protocol.StepDisplayAndWait || step.Display == nil || step.Display.Type != string(bridgev2.LoginDisplayTypeQR) {
		t.Fatalf("first step: got %s %+v, want a QR to display", step.Type, step.Display)
	}
	// Only the URI's scheme is checked and reported: the rest links a device.
	if !strings.HasPrefix(step.Display.Data, "sgnl://linkdevice?") {
		t.Fatalf("the QR isn't a Signal linking URI (starts %.12q)", step.Display.Data)
	}
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "cancel", Type: protocol.CommandLoginCancel, UserID: user, LoginSessionID: session,
	}); err != nil {
		t.Fatal(err)
	}
}

// waitForStep returns the first login step journaled for session.
func waitForStep(t *testing.T, ctx context.Context, h *host.Host, session string) *protocol.LoginStep {
	t.Helper()
	var from int64
	for {
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
		select {
		case <-ctx.Done():
			t.Fatal("no login step within the time limit")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

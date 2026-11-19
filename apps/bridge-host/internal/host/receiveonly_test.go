package host

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func receiveOnly() hostOption { return func(c *Config) { c.ReceiveOnly = true } }

// A receive-only host (Signal's) refuses everything that would put a message on the network
// before it reaches the connector, so nothing is submitted and the refusal is certain.
// Read markers still go out and messages still arrive.
func TestReceiveOnlyRefusesSendsBeforeTheNetwork(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	loginID, portalID := setUpChat(t, h, "chat", "an incoming message")
	target := gw.waitFor(t, "incoming message", isMessage("an incoming message", h, "alice")).EventID
	h.host.Stop()

	// One stored before the host was receive-only (an older version took it) is refused when
	// it runs, and fails: it never went out.
	h2 := buildHost(t, dir, gw, receiveOnly())
	ctx := context.Background()
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.host.Store.EnqueueCommand(ctx, ptr(sendCmd(h2, loginID, portalID, "cm-stored", "stored earlier"))); err != nil {
		t.Fatal(err)
	}
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	gw.waitFor(t, "stored send failed", hasStatus("cm-stored", protocol.StatusFailed))

	send := sendCmd(h2, loginID, portalID, "cm-refused", "never sent")
	edit := sendCmd(h2, loginID, portalID, "cm-edit", "never edited")
	edit.Type, edit.TargetEventID = protocol.CommandEdit, target
	base := protocol.Command{UserID: "alice", LoginID: loginID, PortalID: portalID, TargetEventID: target}
	react, unreact, redact := base, base, base
	react.CommandID, react.Type, react.Key = nextCommandID(), protocol.CommandReact, "👍"
	unreact.CommandID, unreact.Type, unreact.Key = nextCommandID(), protocol.CommandUnreact, "👍"
	redact.CommandID, redact.Type = nextCommandID(), protocol.CommandRedact
	for _, cmd := range []protocol.Command{send, edit, react, unreact, redact} {
		status, body := h2.command(cmd)
		if status != http.StatusConflict || !strings.Contains(body, protocol.ErrUnsupported) {
			t.Errorf("%s: got %d %s, want 409 %s", cmd.Type, status, body, protocol.ErrUnsupported)
		}
	}
	if sent := h2.net.Sent(); len(sent) != 0 {
		t.Fatalf("a receive-only host submitted %d messages", len(sent))
	}

	h2.mustCommand(protocol.Command{
		CommandID: nextCommandID(), Type: protocol.CommandMarkRead, UserID: "alice", LoginID: loginID, PortalID: portalID, UpToEventID: target,
	})
	if err := h2.net.Incoming("alice-fake", "chat", "peer", "after", "still arriving", time.Now()); err != nil {
		t.Fatal(err)
	}
	gw.waitFor(t, "incoming after", isMessage("still arriving", h2, "alice"))
}

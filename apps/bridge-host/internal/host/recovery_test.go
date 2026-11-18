package host

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// setUpChat logs alice in on a fresh host and has someone message her, returning the
// opaque login and portal IDs.
func setUpChat(t *testing.T, h *harness, chat networkid.PortalID, body string) (loginID, portalID string) {
	t.Helper()
	loginID = h.login("alice", "alice-fake")
	if err := h.net.Incoming("alice-fake", chat, "peer", "first-"+networkid.MessageID(chat), body, time.Now()); err != nil {
		t.Fatal(err)
	}
	return loginID, h.gw.waitFor(t, "first message", isMessage(body, h, "alice")).PortalID
}

func sendCmd(h *harness, loginID, portalID, clientMessageID, body string) protocol.Command {
	return protocol.Command{
		CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "alice", LoginID: loginID, PortalID: portalID,
		ClientMessageID: clientMessageID, NotAfter: time.Now().Add(time.Hour).UnixMilli(),
		Sealed: h.sealForBridge("alice", clientMessageID, protocol.MessagePlaintext{Type: "text", Body: body}),
	}
}

func hasStatus(clientMessageID, status string) func(*protocol.Event) bool {
	return func(e *protocol.Event) bool {
		return e.Type == protocol.EventSendStatus && e.ClientMessageID == clientMessageID && e.Status == status
	}
}

// A command acknowledged with 202 but not yet run when the process stops runs after the
// restart: it was stored, payload included, before the 202.
func TestAcknowledgedCommandRunsAfterRestart(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	loginID, portalID := setUpChat(t, h, "chat", "hello")
	h.host.Stop()

	h2 := buildHost(t, dir, gw)
	ctx := context.Background()
	if err := h2.host.Store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h2.host.Store.EnqueueCommand(ctx, ptr(sendCmd(h2, loginID, portalID, "cm-stored", "stored before the restart"))); err != nil {
		t.Fatal(err)
	}
	if err := h2.host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer h2.host.Stop()
	gw.waitFor(t, "stored send sent", hasStatus("cm-stored", protocol.StatusSent))
}

// A send handed off before a crash may have reached the network, so it is settled as
// unknown at startup, never retried.
func TestHandedOffSendIsUnknownAfterRestart(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	loginID, _ := setUpChat(t, h, "chat", "hello")
	ctx := context.Background()
	// As a crash right after the hand-off leaves it: recorded as submitted, outcome unknown.
	if _, err := h.host.Store.InsertOutgoing(ctx, &store.Outgoing{
		UserID: "alice", LoginID: loginID, ClientMessageID: "cm-crashed", EventID: "$crashed", Status: protocol.StatusSubmitted,
	}); err != nil {
		t.Fatal(err)
	}
	h.host.Stop()
	h2 := startHost(t, dir, gw)
	defer h2.host.Stop()
	gw.waitFor(t, "crashed send unknown", hasStatus("cm-crashed", protocol.StatusUnknown))
	if gw.count(hasStatus("cm-crashed", protocol.StatusSent)) != 0 {
		t.Fatal("an interrupted send was retried")
	}
}

// Opaque IDs are hashed with a key kept in the database, so a new bridge key changes none
// of them.
func TestIDsSurviveANewBridgeKey(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	loginID, portalID := setUpChat(t, h, "chat", "hello")
	h.host.Stop()

	newKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h2 := startHost(t, dir, gw, withBridgeKey(newKey))
	defer h2.host.Stop()
	if err = h2.net.Incoming("alice-fake", "chat", "peer", "second", "after the new key", time.Now()); err != nil {
		t.Fatal(err)
	}
	evt := gw.waitFor(t, "message after the new key", isMessage("after the new key", h2, "alice"))
	if evt.PortalID != portalID || evt.LoginID != loginID {
		t.Fatalf("IDs changed with the bridge key: portal %s → %s, login %s → %s", portalID, evt.PortalID, loginID, evt.LoginID)
	}
}

// When the network re-IDs a chat (WhatsApp moving a DM from a phone number to a LID), the
// portal keeps its opaque ID, and sends to it still go out.
func TestPortalKeepsItsIDThroughAReID(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	defer h.host.Stop()
	loginID, portalID := setUpChat(t, h, "phone-chat", "before the re-ID")
	ctx := context.Background()
	_, _, err := h.host.Bridge.ReIDPortal(ctx,
		networkid.PortalKey{ID: "phone-chat", Receiver: "alice-fake"},
		networkid.PortalKey{ID: "lid-chat", Receiver: "alice-fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.net.Incoming("alice-fake", "lid-chat", "peer", "after-reid", "after the re-ID", time.Now()); err != nil {
		t.Fatal(err)
	}
	if evt := gw.waitFor(t, "message after the re-ID", isMessage("after the re-ID", h, "alice")); evt.PortalID != portalID {
		t.Fatalf("portal ID changed with the re-ID: %s → %s", portalID, evt.PortalID)
	}
	h.mustCommand(sendCmd(h, loginID, portalID, "cm-after-reid", "sent after the re-ID"))
	gw.waitFor(t, "send after the re-ID", hasStatus("cm-after-reid", protocol.StatusSent))
	sent := h.net.Sent()
	if last := sent[len(sent)-1]; last.ChatID != "lid-chat" {
		t.Fatalf("send went to %q, not the re-IDed chat", last.ChatID)
	}
}

// A login's QR or pairing code leaves the journal once the gateway has acknowledged it.
func TestLoginCodesAreScrubbedOnceAcknowledged(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	defer h.host.Stop()
	ctx := context.Background()
	evt := &protocol.Event{
		Type: protocol.EventLoginStep, UserID: "alice", LoginSessionID: "s1", At: time.Now().UnixMilli(),
		Step: &protocol.LoginStep{StepID: "qr", Type: protocol.StepDisplayAndWait, Display: &protocol.LoginDisplay{Type: "qr", Data: "2@pairing-secret"}},
	}
	if err := h.host.Store.Append(ctx, evt); err != nil {
		t.Fatal(err)
	}
	h.host.Pusher.Wake()
	gw.waitFor(t, "login step", func(e *protocol.Event) bool { return e.LoginSessionID == "s1" })
	deadline := time.Now().Add(5 * time.Second)
	for {
		events, err := h.host.Store.After(ctx, evt.Seq-1, 1)
		if err != nil {
			t.Fatal(err)
		}
		if events[0].Step.Display.Data == "" {
			return
		} else if time.Now().After(deadline) {
			t.Fatal("the pairing code is still in the journal after the gateway acknowledged it")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The bridge host's own tables on PostgreSQL, which SQLite's leniency can hide problems
// from (a NUL in TEXT, sequence gaps). Set TRIODITIS_TEST_POSTGRES_URI to a scratch
// database to run it.
func TestPostgres(t *testing.T) {
	uri := os.Getenv("TRIODITIS_TEST_POSTGRES_URI")
	if uri == "" {
		t.Skip("set TRIODITIS_TEST_POSTGRES_URI to run against PostgreSQL")
	}
	gw := newFakeGateway(t, "alice")
	h := startHost(t, t.TempDir(), gw, withDatabase("postgres", uri))
	defer h.host.Stop()
	loginID, portalID := setUpChat(t, h, "pg-chat", "hello postgres")
	h.mustCommand(sendCmd(h, loginID, portalID, "cm-pg", "sent on postgres"))
	gw.waitFor(t, "send on postgres", hasStatus("cm-pg", protocol.StatusSent))
	checkOrdered(t, gw.snapshot())
	if status, _ := h.command(sendCmd(h, loginID, "p_unknown", "cm-pg-bad", "x")); status != http.StatusConflict {
		t.Fatalf("expected 409 for an unknown portal, got %d", status)
	}
}

func ptr[T any](v T) *T { return &v }

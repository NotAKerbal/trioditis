//go:build !race

package host

import (
	"testing"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// TestBackgroundedHandlers covers commands still running after bridgev2 has stopped waiting
// on them. To get there in milliseconds rather than five minutes, it sets
// bridgev2.EventHandlingTimeoutTicks to 0, so bridgev2 backgrounds every handler at once.
// bridgev2's backgrounding path has a data race of its own (mautrix v0.33.0
// bridgev2/portal.go, handleSingleEventWithDelayLogging: a handler that finishes as the
// caller gives up writes the result the caller is returning), which the race detector
// reports whenever a quick event takes that path. It isn't ours to fix, and the host's own
// code is covered under -race by TestConformance, so these run only without -race. See the
// README, Known follow-ups.
func TestBackgroundedHandlers(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice")
	h := startHost(t, dir, gw)
	defer h.host.Stop()
	aliceLogin := h.login("alice", "alice-fake")
	const aliceNet = networkid.UserLoginID("alice-fake")
	if err := h.net.Incoming(aliceNet, "family", networkid.UserID(aliceNet), "m-self", "from my phone", time.Now()); err != nil {
		t.Fatal(err)
	}
	portalID := gw.waitFor(t, "a message in the chat", isMessage("from my phone", h, "alice")).PortalID

	sendCommand := func(clientMessageID, body string) protocol.Command {
		return protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: clientMessageID, NotAfter: time.Now().Add(time.Hour).UnixMilli(),
			Sealed: h.sealForBridge("alice", clientMessageID, protocol.MessagePlaintext{Type: "text", Body: body}),
		}
	}
	send := func(clientMessageID, body string) {
		t.Helper()
		h.mustCommand(sendCommand(clientMessageID, body))
	}
	statusOf := func(clientMessageID, status string) func(*protocol.Event) bool {
		return func(e *protocol.Event) bool {
			return e.Type == protocol.EventSendStatus && e.ClientMessageID == clientMessageID && e.Status == status
		}
	}

	t.Run("a send still running after bridgev2 stops waiting holds its chat", func(t *testing.T) {
		// bridgev2 normally gives up waiting after five minutes; with no ticks it gives up at
		// once, and the send carries on in the background.
		ticks := bridgev2.EventHandlingTimeoutTicks
		bridgev2.EventHandlingTimeoutTicks = 0
		defer func() { bridgev2.EventHandlingTimeoutTicks = ticks }()
		h.host.Connector.SendTimeout = 100 * time.Millisecond
		defer func() { h.host.Connector.SendTimeout = 5 * time.Second }()
		before := len(h.net.Sent())
		// Done before holdLimit (ten send timeouts after it is marked unknown) would release
		// the chat anyway.
		h.net.SetSendDelay(900 * time.Millisecond)
		send("cm-background", "still sending")
		send("cm-after-background", "must wait for it")
		// Marked unknown once it has been stuck long enough, while still running...
		gw.waitFor(t, "unknown while still running", statusOf("cm-background", protocol.StatusUnknown))
		h.net.SetSendDelay(0)
		time.Sleep(300 * time.Millisecond)
		// ...but the chat's next send hasn't started alongside it.
		if n := len(h.net.Sent()) - before; n != 0 {
			t.Fatalf("%d sends reached the network while the first was still being handled", n)
		}
		gw.waitFor(t, "the first finishes", statusOf("cm-background", protocol.StatusSent))
		gw.waitFor(t, "then the next goes", statusOf("cm-after-background", protocol.StatusSent))
		if sent := h.net.Sent(); len(sent)-before != 2 || sent[before].Body != "still sending" {
			t.Fatalf("expected both sends in order, got %d", len(sent)-before)
		}
	})

	// bridgev2 normally gives up waiting on a handler after five minutes; with no ticks it
	// gives up at once, and the handler carries on in the background.
	backgroundAtOnce := func(t *testing.T, sendTimeout time.Duration) {
		ticks := bridgev2.EventHandlingTimeoutTicks
		bridgev2.EventHandlingTimeoutTicks = 0
		h.host.Connector.SendTimeout = sendTimeout
		t.Cleanup(func() {
			bridgev2.EventHandlingTimeoutTicks = ticks
			h.host.Connector.SendTimeout = 5 * time.Second
			h.net.SetSendDelay(0)
		})
	}
	waitSubmitted := func(t *testing.T, clientMessageID string) {
		t.Helper()
		gw.waitFor(t, "submitted", statusOf(clientMessageID, protocol.StatusSubmitted))
		// Long enough for bridgev2 to hand it to the network, which reads its delay then.
		time.Sleep(150 * time.Millisecond)
	}

	t.Run("a reaction still running after bridgev2 stops waiting holds its chat, and its late outcome is recorded", func(t *testing.T) {
		// The chat's lane must be free first, so the reaction starts at once: the send before
		// is still running in the connector after its outcome was reported by hand.
		send("cm-before-react", "clears the lane")
		gw.waitFor(t, "the send before", statusOf("cm-before-react", protocol.StatusSent))
		backgroundAtOnce(t, 100*time.Millisecond)
		target := gw.waitFor(t, "a message in this chat", isMessage("from my phone", h, "alice")).EventID
		reactionsBefore, sentBefore := h.net.Reactions(), len(h.net.Sent())
		// Done well after its send timeout, but before holdLimit would release the chat.
		h.net.SetSendDelay(900 * time.Millisecond)
		h.mustCommand(protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandReact, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			TargetEventID: target, Key: "🎉",
		})
		time.Sleep(200 * time.Millisecond)
		h.net.SetSendDelay(0)
		send("cm-after-react", "must wait for the reaction")
		time.Sleep(400 * time.Millisecond)
		if n := len(h.net.Sent()) - sentBefore; n != 0 {
			t.Fatalf("a send overtook a reaction still being handled (%d sent)", n)
		}
		gw.waitFor(t, "the reaction, recorded after its timeout", func(e *protocol.Event) bool {
			return e.Type == protocol.EventReaction && e.TargetEventID == target && e.Key == "🎉" && e.Sender != nil && e.Sender.Self
		})
		gw.waitFor(t, "then the send", statusOf("cm-after-react", protocol.StatusSent))
		if n := h.net.Reactions() - reactionsBefore; n != 1 {
			t.Fatalf("the reaction reached the network %d times", n)
		}
	})

	t.Run("a send in a chat deleted while it runs doesn't hold the chat", func(t *testing.T) {
		backgroundAtOnce(t, 5*time.Second)
		if err := h.net.Incoming(aliceNet, "doomed", "peer-doomed", "x1", "in a chat about to go", time.Now()); err != nil {
			t.Fatal(err)
		}
		doomed := gw.waitFor(t, "the chat's message", isMessage("in a chat about to go", h, "alice")).PortalID
		inDoomed := func(clientMessageID, body string) protocol.Command {
			cmd := sendCommand(clientMessageID, body)
			cmd.PortalID = doomed
			return cmd
		}
		sentBefore := len(h.net.Sent())
		// The network never answers; deleting the chat cancels it, and bridgev2 then reports
		// no outcome at all.
		h.net.SetSendDelay(time.Hour)
		h.mustCommand(inDoomed("cm-doomed", "never answered"))
		waitSubmitted(t, "cm-doomed")
		h.net.SetSendDelay(0)
		h.mustCommand(inDoomed("cm-doomed-next", "queued behind it"))
		time.Sleep(200 * time.Millisecond)
		if n := gw.count(func(e *protocol.Event) bool {
			return e.Type == protocol.EventSendStatus && e.ClientMessageID == "cm-doomed-next"
		}); n != 0 {
			t.Fatal("the next send started while the first was still out")
		}
		if err := h.net.DeleteChat(aliceNet, "doomed"); err != nil {
			t.Fatal(err)
		}
		unknown := gw.waitFor(t, "the orphaned send unknown", statusOf("cm-doomed", protocol.StatusUnknown))
		if unknown.Error == "" {
			t.Fatal("an unknown status needs an error code")
		}
		// The chat is gone, so the next send can't go out, but it runs and ends.
		next := gw.waitFor(t, "the next send settled", func(e *protocol.Event) bool {
			return e.Type == protocol.EventSendStatus && e.ClientMessageID == "cm-doomed-next" && e.Status != protocol.StatusSubmitted
		})
		if next.Status != protocol.StatusFailed {
			t.Fatalf("the next send in a deleted chat ended %s", next.Status)
		}
		if gw.count(statusOf("cm-doomed", protocol.StatusSent)) != 0 || len(h.net.Sent()) != sentBefore {
			t.Fatal("a send in a deleted chat was sent")
		}
	})

	t.Run("a chat held by a connector that never returns is released after the hold limit", func(t *testing.T) {
		backgroundAtOnce(t, 50*time.Millisecond)
		sentBefore := len(h.net.Sent())
		h.net.SetSendDelay(time.Hour)
		send("cm-stuck", "never answered")
		waitSubmitted(t, "cm-stuck")
		h.net.SetSendDelay(0)
		send("cm-after-stuck", "goes once the hold ends")
		gw.waitFor(t, "the stuck send unknown", statusOf("cm-stuck", protocol.StatusUnknown))
		gw.waitFor(t, "the next send goes", statusOf("cm-after-stuck", protocol.StatusSent))
		if sent := h.net.Sent(); len(sent)-sentBefore != 1 || sent[sentBefore].Body != "goes once the hold ends" {
			t.Fatalf("expected only the next send on the network, got %d", len(sent)-sentBefore)
		}
		if gw.count(statusOf("cm-stuck", protocol.StatusSent)) != 0 {
			t.Fatal("the stuck send was reported sent")
		}
	})
}

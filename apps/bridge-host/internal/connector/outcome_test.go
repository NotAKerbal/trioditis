package connector

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

func testConnector(t *testing.T) *Connector {
	t.Helper()
	uri := "file:" + filepath.Join(t.TempDir(), "test.db") + "?_txlock=immediate"
	db, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{Type: "sqlite3-fk-wal", URI: uri, MaxOpenConns: 1}}, dbutil.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	st := store.New(db, dbutil.NoopLogger)
	if err = st.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := New(Options{Network: "test", Store: st, SendTimeout: time.Hour})
	c.Bridge, c.Log = &bridgev2.Bridge{BackgroundCtx: ctx}, zerolog.Nop()
	return c
}

// An outcome whose events the journal refuses (here, a sealed copy over the message limit)
// can never be written, so retrying it would hold the chat for good. The send is recorded
// as unknown instead, and the chat goes on.
func TestAnOutcomeThatCanNeverBeWrittenDoesntHoldTheChat(t *testing.T) {
	c := testConnector(t)
	ctx := context.Background()
	o := &owner{userID: "alice", loginID: "l_alice", portalID: "p_chat"}
	if _, err := c.Store.InsertOutgoing(ctx, &store.Outgoing{UserID: "alice", LoginID: "l_alice", ClientMessageID: "cm-big", Status: protocol.StatusSubmitted}); err != nil {
		t.Fatal(err)
	}
	eventID := id.EventID("$big")
	tooBig := &seal.Envelope{V: 1, Nonce: "n", CT: strings.Repeat("A", 400*1024), Keys: []seal.EnvelopeKey{{KID: "k", SK: "s"}}}
	pending := &pendingCommand{kind: pendingSend, owner: o, clientMessageID: "cm-big", echo: tooBig}
	c.trackPending(eventID, pending)
	c.startTimeout(eventID, pending)

	done := make(chan struct{})
	go func() {
		defer close(done)
		c.SendMessageStatus(ctx, &bridgev2.MessageStatus{Status: event.MessageStatusSuccess}, &bridgev2.MessageStatusEventInfo{SourceEventID: eventID})
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("recording the outcome is still being retried")
	}
	if _, held := c.busy.Load("p_chat"); held {
		t.Fatal("the chat is still held")
	}
	out, err := c.Store.GetOutgoing(ctx, "alice", "cm-big")
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != protocol.StatusUnknown {
		t.Fatalf("expected unknown, got %s", out.Status)
	}
	events, err := c.Store.After(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != protocol.EventSendStatus || events[0].Status != protocol.StatusUnknown {
		t.Fatalf("expected only an unknown status in the journal, got %d events", len(events))
	}
}

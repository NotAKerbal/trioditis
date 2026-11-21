package store

import (
	"context"
	"path/filepath"
	"testing"

	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"maunium.net/go/mautrix/bridgev2/networkid"
)

func openStore(t *testing.T) *Store {
	t.Helper()
	uri := "file:" + filepath.Join(t.TempDir(), "test.db") + "?_txlock=immediate"
	db, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{Type: "sqlite3-fk-wal", URI: uri, MaxOpenConns: 1}}, dbutil.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s := New(db, dbutil.NoopLogger)
	if err = s.Upgrade(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

// Portal values stored before room IDs were (a portal key with a NUL, which PostgreSQL's
// TEXT refuses) become the portal's room ID; the opaque ID stays.
func TestMigratesPortalValues(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	key := networkid.PortalKey{ID: "123@s.whatsapp.net", Receiver: "login"}
	if err := s.PutID(ctx, "p_old", ids.KindPortal, ids.PortalValue(key)); err != nil {
		t.Fatal(err)
	}
	if err := migratePortalValues(ctx, s.DB); err != nil {
		t.Fatal(err)
	}
	value, err := s.LookupID(ctx, "p_old", ids.KindPortal)
	if err != nil {
		t.Fatal(err)
	}
	if value != string(ids.RoomID(key)) {
		t.Fatalf("portal value %q, want the room ID", value)
	}
}

// Sequence numbers come from the appending transaction, so a failed append leaves no gap.
func TestJournalHasNoGaps(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	typing := func() *protocol.Event {
		on, timeout := true, int64(1000)
		return &protocol.Event{Type: protocol.EventTyping, UserID: "alice", LoginID: "l", PortalID: "p", Sender: &protocol.SelfSender, Typing: &on, TimeoutMS: &timeout}
	}
	if err := s.Append(ctx, typing()); err != nil {
		t.Fatal(err)
	}
	failed := s.Txn(ctx, func(ctx context.Context) error {
		if err := s.Append(ctx, typing()); err != nil {
			return err
		}
		return context.Canceled // roll the append back
	})
	if failed == nil {
		t.Fatal("expected the transaction to fail")
	}
	batch := []*protocol.Event{typing(), typing()}
	if err := s.Append(ctx, batch...); err != nil {
		t.Fatal(err)
	}
	events, err := s.After(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	for i, evt := range events {
		if evt.Seq != int64(i+1) {
			t.Fatalf("journal has a gap: %d at position %d", evt.Seq, i)
		}
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
}

func TestIDKeyIsKept(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	first, err := s.IDKey(ctx, []byte("legacy"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.IDKey(ctx, []byte("other legacy"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) || string(first) == "legacy" {
		t.Fatal("a new database must get its own ID key, and keep it")
	}
}

// Recording an acknowledgement scrubs login codes from what it acknowledged in the same
// transaction, so the two can't diverge.
func TestAcknowledgementScrubsLoginCodes(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	step := &protocol.Event{Type: protocol.EventLoginStep, UserID: "alice", LoginSessionID: "s1", At: 1,
		Step: &protocol.LoginStep{StepID: "qr", Type: protocol.StepDisplayAndWait, Display: &protocol.LoginDisplay{Type: "qr", Data: "2@secret-pairing-data"}}}
	later := &protocol.Event{Type: protocol.EventLoginStep, UserID: "alice", LoginSessionID: "s2", At: 1,
		Step: &protocol.LoginStep{StepID: "qr2", Type: protocol.StepDisplayAndWait, Display: &protocol.LoginDisplay{Type: "qr", Data: "2@not-acked-yet"}}}
	if err := s.Append(ctx, step, later); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAckedThrough(ctx, step.Seq); err != nil {
		t.Fatal(err)
	}
	events, err := s.After(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if events[0].Step.Display.Data != "" || events[1].Step.Display.Data == "" {
		t.Fatalf("expected only the acknowledged step scrubbed, got %q and %q", events[0].Step.Display.Data, events[1].Step.Display.Data)
	}
}

// A transaction opened inside another joins it instead of waiting on the write lock its
// caller holds.
func TestNestedTransactionsJoin(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	err := s.Txn(ctx, func(ctx context.Context) error {
		return s.Append(ctx, &protocol.Event{Type: protocol.EventLoginState, UserID: "alice", LoginID: "l", State: "CONNECTED", At: 1})
	})
	if err != nil {
		t.Fatal(err)
	}
	if last, _ := s.LastSeq(ctx); last != 1 {
		t.Fatalf("expected one event, got %d", last)
	}
}

// Reactions indexed before senders were kept get theirs from bridgev2's records when the
// store is upgraded, so a reaction bridgev2 later replaces is still known to be theirs.
func TestBackfillsReactionSenders(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	// The columns of bridgev2's reaction table the backfill reads.
	if _, err := s.DB.Exec(ctx, `CREATE TABLE reaction (mxid TEXT NOT NULL, sender_mxid TEXT NOT NULL, sender_id TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, r := range []struct{ eventID, senderMXID, senderID string }{
		{"$mine", string(ids.UserMXID("alice")), "alice-on-the-network"},
		{"$theirs", string(ids.GhostMXID("bob")), "bob"},
		{"$puppeted", "@someone:elsewhere", "carol"},
	} {
		if err := s.PutReaction(ctx, r.eventID, "$target", "👍", ""); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec(ctx, `INSERT INTO reaction (mxid, sender_mxid, sender_id) VALUES ($1, $2, $3)`, r.eventID, r.senderMXID, r.senderID); err != nil {
			t.Fatal(err)
		}
	}
	// One bridgev2 no longer has keeps its empty sender.
	if err := s.PutReaction(ctx, "$gone", "$target", "👍", ""); err != nil {
		t.Fatal(err)
	}
	if err := backfillReactionSenders(ctx, s.DB); err != nil {
		t.Fatal(err)
	}
	for eventID, want := range map[string]string{"$mine": "self", "$theirs": "ghost:bob", "$puppeted": "ghost:carol", "$gone": ""} {
		if got, err := s.ReactionSender(ctx, eventID); err != nil || got != want {
			t.Errorf("%s: sender %q (%v), want %q", eventID, got, err, want)
		}
	}
}

// A new install has no bridgev2 tables when the store is first upgraded.
func TestBackfillWithoutBridgeTables(t *testing.T) {
	s := openStore(t)
	if err := backfillReactionSenders(context.Background(), s.DB); err != nil {
		t.Fatal(err)
	}
}

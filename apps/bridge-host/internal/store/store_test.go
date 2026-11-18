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
	if err := s.Append(ctx, &protocol.Event{Type: "typing"}); err != nil {
		t.Fatal(err)
	}
	failed := s.Txn(ctx, func(ctx context.Context) error {
		if err := s.Append(ctx, &protocol.Event{Type: "typing"}); err != nil {
			return err
		}
		return context.Canceled // roll the append back
	})
	if failed == nil {
		t.Fatal("expected the transaction to fail")
	}
	batch := []*protocol.Event{{Type: "typing"}, {Type: "typing"}}
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

package signalsweep

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/store/upgrades"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
)

const account = "00000000-0000-4000-8000-000000000001"

// seeded is a database with signalmeow's real tables, made the way mautrix-signal makes them
// (a child of the bridge's database), and one Signal login. The schema package is pure Go,
// so this runs without libsignal.
func seeded(t *testing.T) *dbutil.Database {
	t.Helper()
	path := filepath.Join(t.TempDir(), "signal.db")
	db, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{Type: "sqlite3-fk-wal", URI: "file:" + path + "?_txlock=immediate", MaxOpenConns: 1}}, dbutil.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	// As in wabuffer's tests: one more query takes any connection a cancelled sweep left
	// opening, before the directory is removed.
	t.Cleanup(func() {
		if _, err := db.Exec(context.Background(), "SELECT 1"); err != nil {
			t.Errorf("database unusable before closing: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Errorf("failed to close the database: %v", err)
		}
	})
	ctx := context.Background()
	if err = db.Child("signalmeow_version", upgrades.Table, dbutil.NoopLogger).Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, `INSERT INTO signalmeow_device (aci_uuid, aci_identity_key_pair, registration_id, pni_uuid, pni_identity_key_pair, pni_registration_id, device_id)
		VALUES ($1, $2, 1, $3, $2, 2, 3)`, account, []byte{1}, "00000000-0000-4000-8000-000000000002")
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func buffer(t *testing.T, db *dbutil.Database, hashByte byte, plaintext []byte, age time.Duration) {
	t.Helper()
	hash := make([]byte, 32)
	hash[0] = hashByte
	_, err := db.Exec(context.Background(),
		`INSERT INTO signalmeow_event_buffer (account_id, ciphertext_hash, plaintext, server_timestamp, insert_timestamp) VALUES ($1, $2, $3, $4, $5)`,
		account, hash, plaintext, time.Now().Add(-age).UnixMilli(), time.Now().Add(-age).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
}

func count(t *testing.T, db *dbutil.Database, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A buffered event is kept through Signal's redelivery window, plaintext included, since a
// redelivery can only be bridged from it; past the window it goes, whatever it holds.
func TestSweepDeletesBufferedEventsPastTheWindow(t *testing.T) {
	db := seeded(t)
	buffer(t, db, 1, []byte("plaintext"), MaxAge+time.Hour)
	buffer(t, db, 2, nil, MaxAge+time.Hour)
	buffer(t, db, 3, []byte("plaintext"), MaxAge-time.Hour)
	if err := Sweep(context.Background(), db, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, "signalmeow_event_buffer"); n != 1 {
		t.Fatalf("expected only the row inside the window, %d rows left", n)
	}
}

// An archive's recipients stay while any of its chats is still to be backfilled (backfill
// reads senders, quote and reaction authors from them), and go once none is.
func TestSweepDeletesArchiveRecipientsOnceEveryChatIsBackfilled(t *testing.T) {
	db := seeded(t)
	ctx := context.Background()
	for _, id := range []int{1, 2, 3} {
		if _, err := db.Exec(ctx, `INSERT INTO signalmeow_backup_recipient (account_id, recipient_id, data) VALUES ($1, $2, $3)`, account, id, []byte("name")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO signalmeow_backup_chat (account_id, chat_id, recipient_id, data) VALUES ($1, 10, 1, $2)`, account, []byte("chat")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO signalmeow_backup_message (account_id, chat_id, sender_id, message_id, data) VALUES ($1, 10, 2, 100, $2)`, account, []byte("message")); err != nil {
		t.Fatal(err)
	}
	if err := Sweep(ctx, db, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, "signalmeow_backup_recipient"); n != 3 {
		t.Fatalf("recipients were deleted while a chat was still archived: %d left", n)
	}
	// What the connector does when a chat's backfill is finished.
	if _, err := db.Exec(ctx, `DELETE FROM signalmeow_backup_chat WHERE account_id=$1 AND chat_id=10`, account); err != nil {
		t.Fatal(err)
	}
	if err := Sweep(ctx, db, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, "signalmeow_backup_recipient"); n != 0 {
		t.Fatalf("expected no recipients once every chat was backfilled, %d left", n)
	}
}

// A quiet login gets no incoming message to trigger signalmeow's own cleanup, so the host's
// keeps running: a row that ages past the window later is still removed, and it stops with
// the bridge host.
func TestRunKeepsSweepingUntilStopped(t *testing.T) {
	db := seeded(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		Run(ctx, db, 20*time.Millisecond, zerolog.Nop())
	}()
	time.Sleep(50 * time.Millisecond)
	buffer(t, db, 4, []byte("plaintext"), MaxAge+time.Hour)
	deadline := time.Now().Add(5 * time.Second)
	for count(t, db, "signalmeow_event_buffer") != 0 {
		if time.Now().After(deadline) {
			t.Fatal("a row past the window wasn't swept by a later pass")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweeper didn't stop")
	}
}

// The bridge host stops the sweeper before it stops the host and closes the database, on
// every way out, including while its own context is still live.
func TestStopEndsTheSweeperWhileItsContextIsLive(t *testing.T) {
	db := seeded(t)
	stop := Start(context.Background(), db, time.Hour, zerolog.Nop())
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("stopping the sweeper waited on its parent context")
	}
}

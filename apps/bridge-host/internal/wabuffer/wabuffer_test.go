package wabuffer

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/store/sqlstore/upgrades"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// seeded is a whatsmeow store on SQLite with one login.
func seeded(t *testing.T) (*sqlstore.Container, *dbutil.Database, types.JID) {
	t.Helper()
	uri := "file:" + filepath.Join(t.TempDir(), "wa.db") + "?_txlock=immediate"
	db, err := dbutil.NewFromConfig("test", dbutil.Config{PoolConfig: dbutil.PoolConfig{Type: "sqlite3-fk-wal", URI: uri, MaxOpenConns: 1}}, dbutil.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	// As mautrix-whatsapp opens it: a child of the bridge's database with whatsmeow's tables.
	container := sqlstore.NewWithWrappedDB(db.Child("whatsmeow_version", upgrades.Table, dbutil.NoopLogger), waLog.Noop)
	ctx := context.Background()
	if err = container.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	device := container.NewDevice()
	jid := types.NewJID("15550001111", types.DefaultUserServer)
	device.ID = &jid
	device.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{1}, AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
	if err = container.PutDevice(ctx, device); err != nil {
		t.Fatal(err)
	}
	return container, db, jid
}

func buffer(t *testing.T, db *dbutil.Database, jid types.JID, hashByte byte, age time.Duration) {
	t.Helper()
	hash := make([]byte, 32)
	hash[0] = hashByte
	_, err := db.Exec(context.Background(),
		`INSERT INTO whatsmeow_event_buffer (our_jid, ciphertext_hash, plaintext, server_timestamp, insert_timestamp) VALUES ($1, $2, $3, $4, $5)`,
		jid.String(), hash, []byte("plaintext"), time.Now().Unix(), time.Now().Add(-age).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
}

func rows(t *testing.T, db *dbutil.Database) int {
	t.Helper()
	var n int
	if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM whatsmeow_event_buffer`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSweepDeletesOnlyRowsPastTheRedeliveryWindow(t *testing.T) {
	container, db, jid := seeded(t)
	buffer(t, db, jid, 1, 15*24*time.Hour)
	buffer(t, db, jid, 2, 13*24*time.Hour)
	if err := Sweep(context.Background(), container); err != nil {
		t.Fatal(err)
	}
	if n := rows(t, db); n != 1 {
		t.Fatalf("expected the 13-day row only, %d rows left", n)
	}
}

// A quiet login gets no incoming message to trigger whatsmeow's own sweep, so the host's
// keeps running: a row that ages past the limit later is still removed, and it stops with
// the bridge host.
func TestRunKeepsSweepingUntilStopped(t *testing.T) {
	container, db, jid := seeded(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		Run(ctx, container, 20*time.Millisecond, zerolog.Nop())
	}()
	time.Sleep(50 * time.Millisecond)
	buffer(t, db, jid, 3, 15*24*time.Hour)
	deadline := time.Now().Add(5 * time.Second)
	for rows(t, db) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("a row past the limit wasn't swept by a later pass")
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

package main

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"go.mau.fi/util/dbutil"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// inspect follows the journal and prints each event, decrypting content with the dev
// identity keys. It only works for people logged in with dev keys, which is the point: in
// production the bridge host can't read its own journal.
func inspect(network, dataDir, onlyUser string) error {
	ctx := context.Background()
	uri := "file:" + filepath.Join(dataDir, network+".db") + "?_txlock=immediate"
	db, err := dbutil.NewFromConfig("trioditis-inspect", dbutil.Config{PoolConfig: dbutil.PoolConfig{Type: "sqlite3-fk-wal", URI: uri, MaxOpenConns: 1}}, dbutil.NoopLogger)
	if err != nil {
		return err
	}
	defer db.Close()
	st := store.New(db, dbutil.NoopLogger)
	keys := &devkeys.Keys{Dir: filepath.Join(dataDir, "dev-keys")}
	var from int64
	for {
		events, err := st.After(ctx, from, 200)
		if err != nil {
			return err
		}
		for _, evt := range events {
			from = evt.Seq
			if onlyUser != "" && evt.UserID != onlyUser {
				continue
			}
			fmt.Println(describe(evt, keys))
		}
		if len(events) == 0 {
			time.Sleep(500 * time.Millisecond)
		}
	}
}

func describe(evt *protocol.Event, keys *devkeys.Keys) string {
	line := fmt.Sprintf("#%d %s user=%s", evt.Seq, evt.Type, evt.UserID)
	if evt.Sender != nil {
		if evt.Sender.Self {
			line += " from=self"
		} else {
			line += " from=" + evt.Sender.GhostID
		}
	}
	if evt.Status != "" {
		line += " status=" + evt.Status
	}
	if evt.Error != "" {
		line += " error=" + evt.Error
	}
	if evt.State != "" {
		line += " state=" + evt.State
	}
	if evt.Historical != nil && *evt.Historical {
		line += " historical"
	}
	if evt.Sealed == nil {
		return line
	}
	ctx := seal.Context{OwnerUserID: evt.UserID}
	switch evt.Type {
	case protocol.EventMessage, protocol.EventEdit:
		ctx.Kind, ctx.ObjectID = seal.KindMessage, evt.EventID
	case protocol.EventChat:
		ctx.Kind, ctx.ObjectID = seal.KindChat, evt.PortalID
	case protocol.EventContact:
		ctx.Kind, ctx.ObjectID = seal.KindContact, evt.GhostID
	}
	kp, err := keys.KeyPair(evt.UserID)
	if err != nil {
		return line + " [no dev key]"
	}
	plaintext, err := seal.Open(evt.Sealed, kp, ctx)
	if err != nil {
		return line + " [sealed, not openable with dev keys]"
	}
	return line + " " + string(plaintext)
}

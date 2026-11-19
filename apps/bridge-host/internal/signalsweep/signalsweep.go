// Package signalsweep bounds the plaintext mautrix-signal's store (signalmeow) leaves behind
// in the bridge host's database.
//
// signalmeow keeps each decrypted incoming Signal message (plaintext) in
// signalmeow_event_buffer from decryption until its handler returns success, and then clears
// the plaintext, keeping the row as a hash to recognize a redelivery. A row keeps its
// plaintext only if handling failed or the process stopped in between (the message isn't
// acknowledged, so Signal redelivers it and the buffered copy is what lets it be bridged: a
// Signal message can be decrypted only once), or if clearing it failed (signalmeow logs that
// and still acknowledges the message, so nothing clears it). signalmeow deletes only rows
// already cleared, so such a row would keep its plaintext indefinitely. Signal's server keeps
// an undelivered message 30 days (Signal-Server's message table expiry), so past MaxAge no
// redelivery can come and the row is deleted, plaintext and all.
//
// Linking a device with history transfer leaves the archive's recipients (contact and group
// names, phone numbers) in signalmeow_backup_recipient. The connector deletes each chat and
// its messages from the archive once they are backfilled, but never the recipients. Once an
// account has no archived chat left, nothing reads them, so they are deleted too. The
// archive is written in one transaction (recipients, then chats), so a sweep never sees
// recipients without the chats that are about to reference them.
//
// The bridge host runs the sweep at start-up and every Interval. A sweep that fails (the
// database unavailable, say) leaves the rows for the next. See docs/networks/signal.md.
package signalsweep

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
)

// MaxAge is how long a buffered event is kept: Signal's 30-day redelivery window, plus a
// margin for the server's expiry running late.
const MaxAge = 35 * 24 * time.Hour

// Interval is how often the store is swept. While sweeps succeed, a buffered event's
// plaintext lasts at most about MaxAge plus this.
const Interval = time.Hour

const (
	deleteOldBufferedEvents = `DELETE FROM signalmeow_event_buffer WHERE insert_timestamp < $1`
	deleteFinishedArchives  = `
		DELETE FROM signalmeow_backup_recipient
		WHERE NOT EXISTS (
			SELECT 1 FROM signalmeow_backup_chat
			WHERE signalmeow_backup_chat.account_id = signalmeow_backup_recipient.account_id
		)
	`
)

// Sweep deletes buffered events older than MaxAge and the archived recipients of accounts
// whose archived chats have all been backfilled, for every Signal login in db.
func Sweep(ctx context.Context, db *dbutil.Database, now time.Time) error {
	if _, err := db.Exec(ctx, deleteOldBufferedEvents, now.Add(-MaxAge).UnixMilli()); err != nil {
		return fmt.Errorf("failed to delete old buffered events: %w", err)
	}
	if _, err := db.Exec(ctx, deleteFinishedArchives); err != nil {
		return fmt.Errorf("failed to delete backfilled archive recipients: %w", err)
	}
	return nil
}

// Start runs Run in the background. The function it returns stops it and waits for it to
// finish, so the caller can then close the database; call it before stopping the host,
// whatever ctx is doing.
func Start(ctx context.Context, db *dbutil.Database, interval time.Duration, log zerolog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		Run(ctx, db, interval, log)
	}()
	return func() {
		cancel()
		<-done
	}
}

// Run sweeps now and then every interval, until ctx ends. Only an error's type is logged.
func Run(ctx context.Context, db *dbutil.Database, interval time.Duration, log zerolog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := Sweep(ctx, db, time.Now()); err != nil && ctx.Err() == nil {
			log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Failed to sweep Signal's stored plaintext")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

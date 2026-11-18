// Package wabuffer keeps whatsmeow's decrypted-event buffer within its retention limit.
//
// whatsmeow keeps each decrypted incoming WhatsApp message (plaintext) in
// whatsmeow_event_buffer from decryption until its handler, which journals it sealed,
// returns, and then clears the plaintext. A row keeps its plaintext only if handling failed,
// the process stopped in between, or clearing it failed; WhatsApp redelivers a message that
// wasn't acknowledged, and the buffered copy is what lets it be bridged, since the Signal
// session can't decrypt it twice. Such a row can't be cleared early: it holds no message ID,
// so the host can't tell whether it was bridged, and a row without plaintext makes whatsmeow
// drop the redelivery as already handled.
//
// Past 14 days no redelivery can come, and whatsmeow deletes those rows, but only after an
// incoming message it decrypts, and at most every 12 hours. On a quiet login a row could
// outlive the limit indefinitely, so the bridge host runs the same sweep itself: at start-up
// and every hour. See docs/architecture/sealing.md, What else is stored in plaintext.
package wabuffer

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow/store"
)

// Interval is how often the buffer is swept. A row's plaintext lasts at most about 14 days
// plus this.
const Interval = time.Hour

// Devices lists the WhatsApp logins in the bridge host's database (whatsmeow's
// sqlstore.Container).
type Devices interface {
	GetAllDevices(ctx context.Context) ([]*store.Device, error)
}

// Sweep deletes buffered events older than 14 days, plaintext and all, with whatsmeow's own
// query. That query covers every login's rows, so it runs once, through any login.
func Sweep(ctx context.Context, devices Devices) error {
	all, err := devices.GetAllDevices(ctx)
	if err != nil {
		return fmt.Errorf("failed to list WhatsApp logins: %w", err)
	} else if len(all) == 0 {
		return nil
	}
	return all[0].EventBuffer.DeleteOldBufferedHashes(ctx)
}

// Run sweeps now and then every interval, until ctx ends. Only an error's type is logged.
func Run(ctx context.Context, devices Devices, interval time.Duration, log zerolog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := Sweep(ctx, devices); err != nil && ctx.Err() == nil {
			log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Failed to sweep WhatsApp's decrypted-event buffer")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

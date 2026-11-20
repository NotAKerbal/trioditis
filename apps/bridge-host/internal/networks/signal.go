//go:build libsignal

// Signal links libsignal (Rust, through cgo), so it is only in a build made with
// `-tags libsignal` and libsignal_ffi on the linker path; see docs/networks/signal.md.
//
// mautrix-signal is the patched copy in third_party/mautrix-signal (go.mod's replace):
// upstream submits a message again after an ambiguous outcome, which sends must never be
// (AGENTS.md). See docs/networks/signal.md, Sending.

package networks

import (
	"context"

	"github.com/rs/zerolog"
	signal "go.mau.fi/mautrix-signal/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signalsweep"
)

func init() {
	register("signal", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn, err := withDefaults("Signal", &signal.SignalConnector{})
			if err != nil {
				return nil, err
			}
			sc := conn.(*signal.SignalConnector)
			// The name the person sees for this bridge under Linked devices in Signal.
			sc.Config.DeviceName = "Trioditis"
			// The default is an image on maunium.net's Matrix media server, which the bridge
			// host can't fetch: Note to Self would carry an avatar no client can show.
			sc.Config.NoteToSelfAvatar = ""
			return sc, nil
		},
		// Plaintext signalmeow leaves in its decrypted-event buffer, and the contact and group
		// names from a linked device's history transfer, are deleted once nothing can need
		// them: now, and hourly.
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			sc := conn.(*signal.SignalConnector)
			return signalsweep.Start(ctx, sc.Bridge.DB.Database, signalsweep.Interval, log.With().Str("component", "signal sweep").Logger())
		},
		// signalmeow logs the history transfer's backup key and a contact's name and number at
		// info level; see signallog.go.
		LogFilter: signalLogFilter,
		// Older history comes from the archive the phone transferred at linking, already in
		// the database, so a batch asks Signal's servers only for its attachments and for the
		// profiles of senders not yet cached, one batch at a time. At the host's default a
		// large archive took hours to come in.
		BackfillBatchDelay: 5,
	})
}

const signalBuiltIn = true

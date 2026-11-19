//go:build libsignal

// Signal links libsignal (Rust, through cgo), so it is only in a build made with
// `-tags libsignal` and libsignal_ffi on the linker path; see docs/networks/signal.md.

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
	})
}

const signalBuiltIn = true

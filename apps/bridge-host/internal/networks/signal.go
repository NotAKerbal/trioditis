//go:build libsignal

// Signal links libsignal (Rust, through cgo), so it is only in a build made with
// `-tags libsignal` and libsignal_ffi on the linker path; see docs/networks/signal.md.

package networks

import (
	signal "go.mau.fi/mautrix-signal/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("signal", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Signal", &signal.SignalConnector{})
		},
	})
}

const signalBuiltIn = true

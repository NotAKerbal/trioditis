//go:build !libsignal

package networks

import (
	"errors"

	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("signal", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return nil, errors.New("this bridge host was built without Signal: build it with `-tags libsignal` and libsignal_ffi (see docs/networks/signal.md)")
		},
	})
}

const signalBuiltIn = false

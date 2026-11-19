package networks

import (
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/pkg/fakenet"
)

func init() {
	register("fake", Network{
		New: func() (bridgev2.NetworkConnector, error) { return fakenet.New(), nil },
	})
}

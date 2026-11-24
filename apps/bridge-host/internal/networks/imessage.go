package networks

import (
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage"
)

// iMessage reaches each person's own Mac through the BlueBubbles Server on it. The connector
// is the bridge host's own (internal/imessage): no mautrix connector speaks BlueBubbles on
// bridgev2. See docs/networks/imessage.md.
func init() {
	register("imessage", Network{
		New: func() (bridgev2.NetworkConnector, error) { return &imessage.Connector{}, nil },
	})
}

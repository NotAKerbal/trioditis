package networks

import (
	gvoice "go.mau.fi/mautrix-gvoice/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("gvoice", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Google Voice", &gvoice.GVConnector{})
		},
	})
}

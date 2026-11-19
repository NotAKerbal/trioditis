package networks

import (
	igconnector "go.mau.fi/mautrix-meta/pkg/igconnector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("instagram", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Instagram", &igconnector.IGConnector{})
		},
	})
}

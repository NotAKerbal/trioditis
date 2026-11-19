package networks

import (
	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("gmessages", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Google Messages", &gmessages.GMConnector{})
		},
	})
}

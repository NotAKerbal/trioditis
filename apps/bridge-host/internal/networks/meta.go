package networks

import (
	meta "go.mau.fi/mautrix-meta/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("meta", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Messenger", &meta.MetaConnector{})
		},
	})
}

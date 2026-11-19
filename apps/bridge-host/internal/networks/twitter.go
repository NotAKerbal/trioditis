package networks

import (
	twitter "go.mau.fi/mautrix-twitter/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("twitter", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("X", &twitter.TwitterConnector{})
		},
	})
}

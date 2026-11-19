package networks

import (
	bluesky "go.mau.fi/mautrix-bluesky/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("bluesky", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Bluesky", &bluesky.BlueskyConnector{})
		},
	})
}

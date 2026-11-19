package networks

import (
	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("linkedin", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("LinkedIn", &linkedin.LinkedInConnector{})
		},
	})
}

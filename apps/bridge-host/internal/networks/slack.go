package networks

import (
	slack "go.mau.fi/mautrix-slack/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("slack", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Slack", &slack.SlackConnector{})
		},
	})
}

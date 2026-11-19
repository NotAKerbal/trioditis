package networks

import (
	groupme "github.com/beeper/groupme/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("groupme", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("GroupMe", &groupme.GMConnector{})
		},
	})
}

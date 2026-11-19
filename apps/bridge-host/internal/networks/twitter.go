package networks

import (
	"fmt"

	twitter "go.mau.fi/mautrix-twitter/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

// twitterDisplayname drops the connector's " (Twitter)" suffix, which the app's network
// badge makes redundant, and falls back to the handle for an account with no display name
// rather than leaving the contact nameless.
const twitterDisplayname = "{{ or .DisplayName .Username }}"

func init() {
	register("twitter", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &twitter.TwitterConnector{}
			if _, err := withDefaults("X", conn); err != nil {
				return nil, err
			}
			conn.Config.DisplaynameTemplate = twitterDisplayname
			if err := conn.Config.PostProcess(); err != nil {
				return nil, fmt.Errorf("failed to set the X displayname template: %w", err)
			}
			// The network is called X in the app, so the connector's own texts say so too.
			conn.Config.X = true
			return conn, nil
		},
	})
}

package networks

import (
	"github.com/lib/pq"
	slack "go.mau.fi/mautrix-slack/pkg/connector"
	"go.mau.fi/mautrix-slack/pkg/connector/slackdb"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("slack", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			// The connector prunes a workspace's deleted custom emoji with a Postgres array,
			// through a wrapper its own main sets. Without it the prune calls a nil function
			// and takes the process down, on Postgres (as deployed) only.
			slackdb.PostgresArrayWrapper = pq.Array
			conn, err := withDefaults("Slack", &slack.SlackConnector{})
			if err != nil {
				return nil, err
			}
			// A custom emoji reaction would otherwise be keyed by the content URI of its
			// image. The bridge host keeps uploads only until a sealed event uses them, and
			// a reaction's key isn't sealed, so that URI would lead nowhere. The shortcode
			// (":party-parrot:") is a key the app can show.
			conn.(*slack.SlackConnector).Config.CustomEmojiReactions = false
			return conn, nil
		},
	})
}

package networks

import (
	igconnector "go.mau.fi/mautrix-meta/pkg/igconnector"
	"maunium.net/go/mautrix/bridgev2"
)

// Instagram, from mautrix-meta's igconnector. Unlike Messenger it doesn't use whatsmeow, so
// there is no decrypted-event buffer to sweep; see docs/networks/instagram.md.
func init() {
	register("instagram", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &igconnector.IGConnector{}
			if _, err := withDefaults("Instagram", conn); err != nil {
				return nil, err
			}
			proxy, err := metaProxy("INSTAGRAM_PROXY")
			if err != nil {
				return nil, err
			}
			conn.Config.Proxy = proxy
			return conn, nil
		},
	})
}

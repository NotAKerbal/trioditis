package networks

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/rs/zerolog"
	meta "go.mau.fi/mautrix-meta/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/wabuffer"
)

// Messenger. The connector takes Facebook or Messenger cookies and picks the platform from
// the login flow, so there is no `mode` setting any more; see docs/networks/meta.md.
func init() {
	register("meta", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &meta.MetaConnector{}
			if _, err := withDefaults("Messenger", conn); err != nil {
				return nil, err
			}
			proxy, err := metaProxy("META_PROXY")
			if err != nil {
				return nil, err
			}
			conn.Config.Proxy = proxy
			// Restoring encrypted history asks for a PIN that may be left empty, and the login
			// stepper can't show an optional field, so it stays off whatever the default becomes.
			conn.Config.E2EEBackfill = false
			return conn, nil
		},
		// Messenger's encrypted chats run on whatsmeow, which keeps each decrypted message in
		// its event buffer exactly as it does for WhatsApp, so the same sweep bounds it.
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			m := conn.(*meta.MetaConnector)
			return wabuffer.Start(ctx, m.DeviceStore, wabuffer.Interval, log.With().Str("component", "messenger buffer").Logger())
		},
	})
}

// metaProxy reads the proxy Messenger or Instagram connects through from the environment
// variable name: empty for none, else an http, https or socks5 URL. It is checked here
// because a bad one would otherwise only fail at login, as an unexplained error.
func metaProxy(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%s isn't a proxy URL", name)
	}
	switch parsed.Scheme {
	case "http", "https", "socks5", "socks5h":
		return value, nil
	default:
		return "", fmt.Errorf("%s must be an http, https or socks5 URL, not %s", name, parsed.Scheme)
	}
}

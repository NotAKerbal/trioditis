package networks

import (
	telegram "go.mau.fi/mautrix-telegram/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("telegram", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			return withDefaults("Telegram", &telegram.TelegramConnector{})
		},
	})
}

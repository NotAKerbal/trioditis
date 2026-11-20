package networks

import (
	"context"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-whatsapp/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/wabuffer"
)

func init() {
	register("whatsapp", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &connector.WhatsAppConnector{}
			if _, err := withDefaults("WhatsApp", conn); err != nil {
				return nil, err
			}
			// The phone sends history once, when a login is paired. By default that is about
			// three months; a full sync asks for about a year. It only applies to logins paired
			// after it is on, so an existing login needs relinking to get it.
			conn.Config.HistorySync.RequestFullSync = true
			// Once a chat's synced history runs out, the backfill queue asks the phone for older
			// messages, a chat at a time, for as long as the phone says there are more.
			// Otherwise a chat stops at whatever the pairing sync happened to include.
			conn.Config.HistorySync.BackwardsOnDemand = true
			return conn, nil
		},
		// Plaintext left in whatsmeow's decrypted-event buffer is deleted once it is past
		// WhatsApp's redelivery window: now, and hourly, rather than only when a message
		// arrives.
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			wa := conn.(*connector.WhatsAppConnector)
			return wabuffer.Start(ctx, wa.DeviceStore, wabuffer.Interval, log.With().Str("component", "whatsapp buffer").Logger())
		},
	})
}

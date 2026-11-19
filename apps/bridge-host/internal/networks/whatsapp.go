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
			return withDefaults("WhatsApp", &connector.WhatsAppConnector{})
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

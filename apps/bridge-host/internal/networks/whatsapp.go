package networks

import (
	"context"
	"fmt"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-whatsapp/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
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
			return &whatsappConnector{WhatsAppConnector: conn}, nil
		},
		// Plaintext left in whatsmeow's decrypted-event buffer is deleted once it is past
		// WhatsApp's redelivery window: now, and hourly, rather than only when a message
		// arrives.
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			wa := conn.(*whatsappConnector)
			return wabuffer.Start(ctx, wa.DeviceStore, wabuffer.Interval, log.With().Str("component", "whatsapp buffer").Logger())
		},
	})
	// The connector reports parts journaled for the remote event bridgev2 is handling; for
	// WhatsApp's messages, the event its handler is waiting on is the whatsmeow message inside.
	handled.AddKey(func(remote any) any {
		switch evt := remote.(type) {
		case *connector.WAMessageEvent:
			if evt.MsgEvent != nil {
				return evt.MsgEvent
			}
		case *connector.WANowDecryptableMessage:
			if evt.WAMessageEvent != nil && evt.MsgEvent != nil {
				return evt.MsgEvent
			}
		}
		return nil
	})
}

// whatsappConnector is mautrix-whatsapp's connector, with each login's whatsmeow handler
// wrapped so a message is acknowledged only once it is journaled (wabuffer.Acker). It embeds
// the connector, so bridgev2 sees every method and optional interface the connector has.
type whatsappConnector struct {
	*connector.WhatsAppConnector
}

// LoadUserLogin makes the login's client as mautrix-whatsapp does, then wraps its handlers
// before it connects. A login whose handlers can't be wrapped isn't loaded: running it would
// acknowledge messages that a stop could still lose.
func (wa *whatsappConnector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	if err := wa.WhatsAppConnector.LoadUserLogin(ctx, login); err != nil {
		return err
	}
	client, ok := login.Client.(*connector.WhatsAppClient)
	if !ok || client.Client == nil {
		// No device yet (a login that is being set up): nothing receives messages.
		return nil
	}
	// The bridge's logger, not the login's: that one carries the raw login ID, a phone number.
	acker := handled.NewAcker(wa.Bridge.BackgroundCtx, wa.Bridge.Log.With().Str("component", "whatsapp ack").Logger())
	if err := wabuffer.WrapHandlers(client.Client, wabuffer.WrapAck(acker)); err != nil {
		return fmt.Errorf("failed to wrap the WhatsApp event handler: %w", err)
	}
	return nil
}

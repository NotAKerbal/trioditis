//go:build libsignal

// Signal links libsignal (Rust, through cgo), so it is only in a build made with
// `-tags libsignal` and libsignal_ffi on the linker path; see docs/networks/signal.md.
//
// mautrix-signal is the patched copy in third_party/mautrix-signal (go.mod's replace):
// upstream submits a message again after an ambiguous outcome, which sends must never be
// (AGENTS.md). See docs/networks/signal.md, Sending.

package networks

import (
	"context"

	"github.com/rs/zerolog"
	signal "go.mau.fi/mautrix-signal/pkg/connector"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/events"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signalsweep"
)

func init() {
	register("signal", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn, err := withDefaults("Signal", &signal.SignalConnector{})
			if err != nil {
				return nil, err
			}
			sc := conn.(*signal.SignalConnector)
			// The name the person sees for this bridge under Linked devices in Signal.
			sc.Config.DeviceName = "Trioditis"
			// The default is an image on maunium.net's Matrix media server, which the bridge
			// host can't fetch: Note to Self would carry an avatar no client can show.
			sc.Config.NoteToSelfAvatar = ""
			return &signalConnector{SignalConnector: sc}, nil
		},
		// Plaintext signalmeow leaves in its decrypted-event buffer, and the contact and group
		// names from a linked device's history transfer, are deleted once nothing can need
		// them: now, and hourly.
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			sc := conn.(*signalConnector)
			return signalsweep.Start(ctx, sc.Bridge.DB.Database, signalsweep.Interval, log.With().Str("component", "signal sweep").Logger())
		},
		// signalmeow logs the history transfer's backup key and a contact's name and number at
		// info level; see signallog.go.
		LogFilter: signalLogFilter,
		// Older history comes from the archive the phone transferred at linking, already in
		// the database, so a batch asks Signal's servers only for its attachments and for the
		// profiles of senders not yet cached, one batch at a time. At the host's default a
		// large archive took hours to come in.
		BackfillBatchDelay: 5,
	})
	// The connector reports writes for the remote event bridgev2 is handling; for Signal's
	// messages, the event its handler is waiting on is the signalmeow event inside.
	handled.AddKey(func(remote any) any {
		if evt, ok := remote.(*signal.Bv2ChatEvent); ok && evt.ChatEvent != nil {
			return evt.ChatEvent
		}
		return nil
	})
}

// signalConnector is mautrix-signal's connector, with each login's signalmeow handler
// wrapped so a message is acknowledged only once it is journaled (handled.Acker). It embeds
// the connector, so bridgev2 sees every method and optional interface the connector has.
type signalConnector struct {
	*signal.SignalConnector
}

// LoadUserLogin makes the login's client as mautrix-signal does, then wraps its handler before
// it connects. signalmeow answers Signal's server for an envelope (acknowledging it, and
// clearing its buffered plaintext) once the handler returns success, as whatsmeow does.
func (sc *signalConnector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	if err := sc.SignalConnector.LoadUserLogin(ctx, login); err != nil {
		return err
	}
	client, ok := login.Client.(*signal.SignalClient)
	if !ok || client.Client == nil || client.Client.EventHandler == nil {
		// No device yet (a login that is being set up): nothing receives messages.
		return nil
	}
	// The bridge's logger, not the login's: that one carries the login's raw ID.
	acker := handled.NewAcker(sc.Bridge.BackgroundCtx, sc.Bridge.Log.With().Str("component", "signal ack").Logger())
	client.Client.EventHandler = wrapSignalAck(acker, client.Client.EventHandler)
	return nil
}

// wrapSignalAck holds back chat events (messages, edits, reactions, deletions), what Signal
// would not send again, until they are journaled.
func wrapSignalAck(a *handled.Acker, next func(events.SignalEvent) bool) func(events.SignalEvent) bool {
	return func(evt events.SignalEvent) bool {
		chat, ok := evt.(*events.ChatEvent)
		if !ok {
			return next(evt)
		}
		return a.Handle(chat, func() bool { return next(evt) })
	}
}

const signalBuiltIn = true

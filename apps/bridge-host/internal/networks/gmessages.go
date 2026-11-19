package networks

import (
	"time"
	_ "unsafe" // for go:linkname, below

	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

// gmessagesSendRetryBackoff is mautrix-gmessages' list of waits before it sends a message
// again after the phone answered with a "transient" failure (FAILURE_2 or FAILURE_3,
// handlematrix.go). The connector itself reports those failures as uncertain: the phone may
// have sent the SMS anyway. A send is never repeated after an ambiguous outcome here
// (AGENTS.md), so the list is emptied and such a send is reported as unknown instead. If
// the connector renames the variable the build fails, so this can't silently stop working.
//
//go:linkname gmessagesSendRetryBackoff go.mau.fi/mautrix-gmessages/pkg/connector.sendRetryBackoff
var gmessagesSendRetryBackoff []time.Duration

func init() {
	register("gmessages", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn, err := withDefaults("Google Messages", &gmessages.GMConnector{})
			if err != nil {
				return nil, err
			}
			gmessagesSendRetryBackoff = nil
			gm := conn.(*gmessages.GMConnector)
			// The name the phone shows in Device pairing, so the person can tell which paired
			// device is this server.
			gm.Config.DeviceMeta.OS = "Trioditis"
			// Google Messages lets one web session be active at a time. Opening it in a browser
			// makes the bridge inactive, and upstream expects a `set-active` bot command to take
			// it back; Trioditis has no bot commands, so the bridge takes the session back by
			// itself a few seconds later.
			gm.Config.AggressiveReconnect = true
			// A send is confirmed by the phone echoing it, which can take minutes. bridgev2's
			// own timeouts for that echo report the send as uncertain, which settles it as
			// unknown for good, so the echo that follows is dropped. Without them the bridge
			// host waits itself and still records a late echo as sent (its pendingRetention).
			// The capabilities are the connector's shared value, and one process runs one
			// connector, so changing them here changes them for this process only.
			gm.GetCapabilities().OutgoingMessageTimeouts = nil
			return gm, nil
		},
	})
}

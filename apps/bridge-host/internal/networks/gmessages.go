package networks

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
	_ "unsafe" // for go:linkname, below

	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/util"
	"go.mau.fi/util/pblite"
	"google.golang.org/protobuf/proto"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/connector"
)

// gmessagesSendRetryBackoff is mautrix-gmessages' list of waits before it sends a message
// again after the phone answered with a "transient" failure (FAILURE_2 or FAILURE_3,
// handlematrix.go). The connector itself reports those failures as uncertain: the phone may
// have sent the SMS anyway. A send is never repeated after an ambiguous outcome here
// (AGENTS.md), so the list is emptied and such a send is reported as unknown instead. The
// connector has no option for this, hence the linkname.
//
// If the connector renamed the variable the build would still succeed, with this one a
// variable of its own; gmessagesClearRetries then refuses to make the connector, so the
// bridge host fails at start rather than resending.
//
//go:linkname gmessagesSendRetryBackoff go.mau.fi/mautrix-gmessages/pkg/connector.sendRetryBackoff
var gmessagesSendRetryBackoff []time.Duration

// gmessagesClearRetries empties the connector's retry waits, once per process. The
// connector only reads the variable, which Go sets before any of this package's code runs,
// so nothing fills it again later. An empty list before the first clear means the linkname
// reached no variable of the connector's.
var gmessagesClearRetries = sync.OnceValue(func() error {
	if len(gmessagesSendRetryBackoff) == 0 {
		return errors.New("google messages: the connector's sendRetryBackoff wasn't found, so its send retries can't be turned off; check the go:linkname in gmessages.go against the pinned connector")
	}
	gmessagesSendRetryBackoff = nil
	return nil
})

func init() {
	register("gmessages", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn, err := withDefaults("Google Messages", &gmessages.GMConnector{})
			if err != nil {
				return nil, err
			}
			if err = gmessagesClearRetries(); err != nil {
				return nil, err
			}
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
			return &gmessagesConnector{gm}, nil
		},
	})
}

// gmessagesConnector is mautrix-gmessages with one change: a message is posted to Google's
// relay at most once. libgm posts a request again, same body, after a 5xx from the relay
// (libgm/http.go, up to three attempts), and the HTTP client follows a 307 or 308 by posting
// the body again; a relay that passed the message on to the phone before answering would get
// it twice. libgm builds its HTTP clients from the bridge's client settings and keeps them to
// itself, so the bridge host's connector puts gmessagesSendOnce around their transport
// (WrapHTTPTransport). Everything else is the connector's own: the embedded pointer keeps
// every optional interface it implements.
type gmessagesConnector struct {
	*gmessages.GMConnector
}

var _ connector.HTTPTransportWrapper = (*gmessagesConnector)(nil)

func (gm *gmessagesConnector) WrapHTTPTransport(next http.RoundTripper) http.RoundTripper {
	return &gmessagesSendOnce{next: next}
}

// gmessagesRelayURLs are the relay endpoints every request to the phone is posted to, with
// or without a Google account: host and path.
var gmessagesRelayURLs = func() map[[2]string]bool {
	urls := map[[2]string]bool{}
	for _, raw := range []string{util.SendMessageURL, util.SendMessageURLGoogle} {
		parsed, err := url.Parse(raw)
		if err != nil {
			panic(err)
		}
		urls[[2]string{parsed.Host, parsed.Path}] = true
	}
	return urls
}()

// gmessagesFrameLimit is more than any text message's frame; a larger body is treated as a
// send without being read.
const gmessagesFrameLimit = 1 << 20

// gmessagesSendOnce makes a send's ambiguous answer from the relay final. A send is a
// SEND_MESSAGE request; every other request to the phone (sync, read markers, media
// lookups) shares the endpoint and keeps libgm's retries. When a send is answered with a 5xx
// or a redirect, the answer is replaced with an error that is an uncertain
// bridgev2.MessageStatus: libgm doesn't retry a request that fails in transport, the
// connector returns a MessageStatus as it is (errors.go, wrapSendError), and the bridge host
// records an uncertain failure as unknown. A send that fails in transport is already final
// in libgm and reported as uncertain by the connector, so it is passed on unchanged.
type gmessagesSendOnce struct {
	next http.RoundTripper
}

func (t *gmessagesSendOnce) RoundTrip(req *http.Request) (*http.Response, error) {
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	if !gmessagesIsSend(req) {
		return next.RoundTrip(req)
	}
	resp, err := next.RoundTrip(req)
	if err != nil || resp.StatusCode < 300 || (resp.StatusCode >= 400 && resp.StatusCode < 500) {
		return resp, err
	}
	code := resp.StatusCode
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	_ = resp.Body.Close()
	return nil, bridgev2.WrapErrorInStatus(fmt.Errorf("google messages relay answered a send with status %d; not sent again", code)).
		WithMessage("Google Messages server returned an error; the message may have been sent").
		WithErrorReason(event.MessageStatusNetworkError).
		WithIsCertain(false).
		WithSendNotice(true)
}

// gmessagesIsSend reports whether req posts a SEND_MESSAGE request to the relay. The action
// is in the clear in the frame (OutgoingRPCData.Action); only its payload is encrypted. A
// relay post whose action can't be read, or reads as none, is treated as a send, so a change
// in the frame's format can only take retries away, never add a resend.
func gmessagesIsSend(req *http.Request) bool {
	if req.Method != http.MethodPost || !gmessagesRelayURLs[[2]string{req.URL.Host, req.URL.Path}] {
		return false
	}
	if req.GetBody == nil || req.ContentLength < 0 || req.ContentLength > gmessagesFrameLimit {
		return true
	}
	body, err := req.GetBody()
	if err != nil {
		return true
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, gmessagesFrameLimit))
	if err != nil {
		return true
	}
	var frame gmproto.OutgoingRPCMessage
	var rpc gmproto.OutgoingRPCData
	if pblite.Unmarshal(data, &frame) != nil || proto.Unmarshal(frame.GetData().GetMessageData(), &rpc) != nil {
		return true
	}
	action := rpc.GetAction()
	return action == gmproto.ActionType_SEND_MESSAGE || action == gmproto.ActionType_UNSPECIFIED
}

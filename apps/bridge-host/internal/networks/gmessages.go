package networks

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
	_ "unsafe" // for go:linkname, below

	"github.com/rs/zerolog"
	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
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
			return &gmessagesConnector{GMConnector: gm}, nil
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
	// log is the bridge's, once Init has run, for what the HTTP transport notices.
	log zerolog.Logger
}

var (
	_ connector.HTTPTransportWrapper = (*gmessagesConnector)(nil)
	_ connector.LoginErrorDescriber  = (*gmessagesConnector)(nil)
)

func (gm *gmessagesConnector) Init(br *bridgev2.Bridge) {
	gm.GMConnector.Init(br)
	gm.log = br.Log.With().Str("component", "gmessages cookies").Logger()
}

func (gm *gmessagesConnector) WrapHTTPTransport(next http.RoundTripper) http.RoundTripper {
	return &gmessagesSendOnce{next: next, log: gm.log}
}

// gmessagesSignInCookies are the cookies a Google account login hands libgm (the connector's
// cookie step). libgm copies whatever Google sets in a reply over its own copy, a removal as
// an empty value, and sends that from then on; Google answering 401 just after a reply that
// changed one would show it. Only their names are logged, never values.
var gmessagesSignInCookies = map[string]bool{
	"SID": true, "HSID": true, "SSID": true, "APISID": true, "SAPISID": true, "OSID": true,
	"__Secure-1PSIDTS": true,
}

// noteSignInCookies logs which sign-in cookies a reply from Google sets or removes.
func noteSignInCookies(log zerolog.Logger, resp *http.Response) {
	var changed, removed []string
	now := time.Now()
	for _, ck := range resp.Cookies() {
		if !gmessagesSignInCookies[ck.Name] {
			continue
		}
		if ck.MaxAge < 0 || ck.Value == "" || (!ck.Expires.IsZero() && ck.Expires.Before(now)) {
			if !slices.Contains(removed, ck.Name) {
				removed = append(removed, ck.Name)
			}
		} else if !slices.Contains(changed, ck.Name) {
			changed = append(changed, ck.Name)
		}
	}
	if len(changed) == 0 && len(removed) == 0 {
		return
	}
	log.Info().
		Strs("changed", changed).
		Strs("removed", removed).
		Str("http_endpoint", gmessagesEndpoint(resp)).
		Int("http_status", resp.StatusCode).
		Msg("Google changed sign-in cookies")
}

// gmessagesLoginSteps names libgm's steps by the start its errors give them, for the ones a
// Google account login goes through before the phone shows its emoji and after.
var gmessagesLoginSteps = []struct{ prefix, step string }{
	{"failed to fetch config: ", "fetch_config"},
	{"failed to prepare gaia pairing: ", "find_phone"},
	{"failed to parse destination UUID: ", "find_phone"},
	{"failed to prepare pairing payloads: ", "prepare_pairing"},
	{"failed to send client init: ", "send_client_init"},
	{"error processing server init: ", "server_init"},
	{"failed to send client finish: ", "send_client_finish"},
}

// gmessagesLoginCodes are the codes of the connector's own login errors, which replace
// libgm's for the failures it knows: a name for each and the part of the login it ends.
// "start_pairing" is everything before the phone shows the emoji, "finish_pairing" after.
var gmessagesLoginCodes = map[string]struct{ name, step string }{
	gmessages.ErrPairNoDevices.ErrCode:          {"no_devices_found", "start_pairing"},
	gmessages.ErrPairPhoneNotFound.ErrCode:      {"phone_not_found", "start_pairing"},
	gmessages.ErrPairPhoneInactive.ErrCode:      {"phone_inactive", "start_pairing"},
	gmessages.ErrPairPhoneNotResponding.ErrCode: {"phone_not_responding", "start_pairing"},
	gmessages.ErrPairCallerNoPermission.ErrCode: {"account_cant_pair", "start_pairing"},
	gmessages.ErrPairIncorrectEmoji.ErrCode:     {"incorrect_emoji", "finish_pairing"},
	gmessages.ErrPairCancelled.ErrCode:          {"pairing_cancelled", "finish_pairing"},
	gmessages.ErrPairTimeout.ErrCode:            {"pairing_timeout", "finish_pairing"},
}

// gmessagesUnknownLogin are the connector's catch-all login errors, which share M_UNKNOWN and
// differ only in their (constant) message, which gets Google's error number appended to it.
var gmessagesUnknownLogin = []struct {
	err        bridgev2.RespError
	name, step string
}{
	{gmessages.ErrPairStartUnknown, "pair_start_unknown", "start_pairing"},
	{gmessages.ErrPairWaitUnknown, "pair_wait_unknown", "finish_pairing"},
}

// gmessagesLibgmErrors are libgm's own errors a login can end in, by a name for the log.
var gmessagesLibgmErrors = []struct {
	err  error
	name string
}{
	{libgm.ErrNoCookies, "no_cookies"},
	{libgm.ErrNoDevicesFound, "no_devices_found"},
	{libgm.ErrPhoneNotFound, "phone_not_found"},
	{libgm.ErrPhoneInactive, "phone_inactive"},
	{libgm.ErrPairingInitTimeout, "pairing_init_timeout"},
	{libgm.ErrHadMultipleDevices, "multiple_devices"},
	{libgm.ErrIncorrectEmoji, "incorrect_emoji"},
	{libgm.ErrPairingCancelled, "pairing_cancelled"},
	{libgm.ErrPairingTimeout, "pairing_timeout"},
	{libgm.ErrPhoneNotResponding, "phone_not_responding"},
	{libgm.ErrConnectionClosed, "connection_closed"},
}

// gmessagesEndpoints names the endpoints libgm calls by host and path. Anything else, such as
// where a redirect ended up, is logged as "other": a path can carry an account's details.
var gmessagesEndpoints = func() map[string]string {
	names := map[string]string{}
	for _, raw := range []string{
		util.ConfigURL, util.GoogleAuthenticationURL, util.GoogleTimesourceURL, util.UploadMediaURL,
		util.RegisterPhoneRelayURL, util.RefreshPhoneRelayURL, util.GetWebEncryptionKeyURL,
		util.RevokeRelayPairingURL, util.ReceiveMessagesURL, util.SendMessageURL, util.AckMessagesURL,
		util.ReceiveMessagesURLGoogle, util.SendMessageURLGoogle, util.AckMessagesURLGoogle,
		util.SignInGaiaURL, util.RegisterRefreshURL,
	} {
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		names[u.Host+u.Path] = path.Base(u.Path)
	}
	return names
}()

func gmessagesEndpoint(resp *http.Response) string {
	if resp.Request == nil || resp.Request.URL == nil {
		return ""
	}
	if name, ok := gmessagesEndpoints[resp.Request.URL.Host+resp.Request.URL.Path]; ok {
		return name
	}
	return "other"
}

// DescribeLoginError says which step a failed login stopped at, the connector's and libgm's
// names for the failure, and Google's HTTP status, endpoint and error number. Google's error
// message and response body are left out: they are Google's words about the person's account.
// It reads only fields and constant messages: libgm's errors' Error methods dereference
// pointers an odd error may not have.
func (gm *gmessagesConnector) DescribeLoginError(evt *zerolog.Event, err error) {
	var steps, names []string
	add := func(list []string, value string) []string {
		if value == "" || slices.Contains(list, value) {
			return list
		}
		return append(list, value)
	}
	googleType, status, endpoint := int64(0), 0, ""
	httpSeen := func(h *events.HTTPError) {
		if h != nil && h.Resp != nil && status == 0 {
			status, endpoint = h.Resp.StatusCode, gmessagesEndpoint(h.Resp)
		}
	}
	requestSeen := func(r *events.RequestError) {
		if r == nil {
			return
		}
		if r.Data != nil && googleType == 0 {
			googleType = r.Data.GetType()
		}
		httpSeen(r.HTTP)
	}
	connector.WalkErrors(err, func(e error) {
		switch typed := e.(type) {
		case events.RequestError:
			requestSeen(&typed)
		case *events.RequestError:
			requestSeen(typed)
		case events.HTTPError:
			httpSeen(&typed)
		case *events.HTTPError:
			httpSeen(typed)
		case bridgev2.RespError:
			if known, ok := gmessagesLoginCodes[typed.ErrCode]; ok {
				names, steps = add(names, known.name), add(steps, known.step)
			}
			for _, unknown := range gmessagesUnknownLogin {
				if typed.ErrCode == unknown.err.ErrCode && strings.HasPrefix(typed.Err, unknown.err.Err) {
					names, steps = add(names, unknown.name), add(steps, unknown.step)
				}
			}
		}
		// fmt's wrappers keep their message as made, so reading it dereferences nothing. It is
		// matched against libgm's constant starts, never logged.
		if kind := fmt.Sprintf("%T", e); kind == "*fmt.wrapError" || kind == "*fmt.wrapErrors" {
			text := e.Error()
			for _, s := range gmessagesLoginSteps {
				if strings.HasPrefix(text, s.prefix) {
					steps = add(steps, s.step)
					break
				}
			}
		}
		for _, k := range gmessagesLibgmErrors {
			// Sentinels are pointers, so this compares identity and never a struct's fields.
			if e == k.err {
				names = add(names, k.name)
			}
		}
	})
	if len(steps) > 0 {
		evt.Strs("gm_steps", steps)
	}
	if len(names) > 0 {
		evt.Strs("gm_errors", names)
	}
	if googleType != 0 {
		evt.Int64("google_error_type", googleType)
	}
	if status != 0 {
		evt.Int("http_status", status)
		if endpoint != "" {
			evt.Str("http_endpoint", endpoint)
		}
	}
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
	log  zerolog.Logger
}

// CloseIdleConnections passes libgm's clean-up on disconnect (http.Client's
// CloseIdleConnections, which only reaches a transport that has the method) to the transport
// underneath.
func (t *gmessagesSendOnce) CloseIdleConnections() {
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	if closer, ok := next.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func (t *gmessagesSendOnce) RoundTrip(req *http.Request) (*http.Response, error) {
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	if !gmessagesIsSend(req) {
		resp, err := next.RoundTrip(req)
		if resp != nil {
			noteSignInCookies(t.log, resp)
		}
		return resp, err
	}
	resp, err := next.RoundTrip(req)
	if resp != nil {
		noteSignInCookies(t.log, resp)
	}
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

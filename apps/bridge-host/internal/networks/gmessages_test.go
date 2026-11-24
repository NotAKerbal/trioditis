package networks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	gmessages "go.mau.fi/mautrix-gmessages/pkg/connector"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
	"go.mau.fi/util/exhttp"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// newTestHost makes a bridge host, not started, for a network's connector.
func newTestHost(t *testing.T, network string, conn bridgev2.NetworkConnector) *host.Host {
	t.Helper()
	dir := t.TempDir()
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h, err := host.New(host.Config{
		Network:          network,
		DataDir:          dir,
		BridgeKey:        bridgeKey,
		NetworkConnector: conn,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		Log:              zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// googleLoginFirstStep starts a network's login through a bridge host the way the gateway
// would (a loginStart command), returns the first step it reports, and cancels the login.
// It needs no account: it stops before anything is submitted.
func googleLoginFirstStep(t *testing.T, network string, conn bridgev2.NetworkConnector, flowID string) *protocol.LoginStep {
	t.Helper()
	h := newTestHost(t, network, conn)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)

	const user, session = "test", "login-1"
	if err := h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "start", Type: protocol.CommandLoginStart, UserID: user, LoginSessionID: session,
		Network: network, FlowID: flowID,
	}); err != nil {
		t.Fatalf("loginStart: %v", err)
	}
	step := waitForLoginStep(ctx, t, h, session, 0)
	if err := h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "cancel", Type: protocol.CommandLoginCancel, UserID: user, LoginSessionID: session,
	}); err != nil {
		t.Fatalf("loginCancel: %v", err)
	}
	if last := waitForLoginStep(ctx, t, h, session, step.seq); last.Type != protocol.StepCancelled {
		t.Fatalf("after loginCancel: got a %q step, want cancelled", last.Type)
	}
	return step.LoginStep
}

type journaledStep struct {
	*protocol.LoginStep
	seq int64
}

// waitForLoginStep returns the first step of the login journaled after seq.
func waitForLoginStep(ctx context.Context, t *testing.T, h *host.Host, session string, seq int64) journaledStep {
	t.Helper()
	for {
		events, err := h.Store.After(ctx, seq, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range events {
			seq = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return journaledStep{evt.Step, evt.Seq}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("no login step was journaled")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// The connector's own retry waits, read before any New empties them: proof that the
// linkname reaches the connector's variable rather than a copy of its own.
var gmessagesUpstreamRetries = slices.Clone(gmessagesSendRetryBackoff)

func TestGMessagesConnector(t *testing.T) {
	if len(gmessagesUpstreamRetries) == 0 {
		t.Fatal("gmessagesSendRetryBackoff isn't linked to the connector's sendRetryBackoff")
	}
	conn, err := registry["gmessages"].New()
	if err != nil {
		t.Fatal(err)
	}
	wrapped, ok := conn.(*gmessagesConnector)
	if !ok {
		t.Fatalf("connector: got %T", conn)
	}
	// Wrapping it mustn't hide what bridgev2 looks for on the connector.
	if _, ok := conn.(bridgev2.TransactionIDGeneratingNetwork); !ok {
		t.Error("the wrapper hides TransactionIDGeneratingNetwork")
	}
	if _, ok := conn.(bridgev2.IdentifierValidatingNetwork); !ok {
		t.Error("the wrapper hides IdentifierValidatingNetwork")
	}
	gm := wrapped.GMConnector
	if gm.Config.DeviceMeta.OS != "Trioditis" || gm.Config.DeviceMeta.Type != "TABLET" || gm.Config.DeviceMeta.Browser != "OTHER" {
		t.Errorf("device meta: %+v", gm.Config.DeviceMeta)
	}
	if !gm.Config.AggressiveReconnect {
		t.Error("the bridge must take its session back by itself: Trioditis has no set-active command")
	}
	if gm.Config.InitialChatSyncCount != 25 || gm.Config.PingInterval != 20*time.Minute {
		t.Errorf("example defaults not loaded: %+v", gm.Config)
	}
	// The display name template was parsed from the example config.
	if name := gm.Config.FormatDisplayname("+1 555 0100", "", ""); name != "+1 555 0100" {
		t.Errorf("display name falls back to the phone number: got %q", name)
	}
	if gm.GetCapabilities().OutgoingMessageTimeouts != nil {
		t.Error("bridgev2's echo timeouts would settle slow sends as unknown before the phone confirms them")
	}
	if len(gmessagesSendRetryBackoff) != 0 {
		t.Errorf("the connector would send again after an uncertain failure: %v", gmessagesSendRetryBackoff)
	}
	// A second connector in the same process is made too: the clear is once per process.
	if _, err = registry["gmessages"].New(); err != nil {
		t.Errorf("a second New: %v", err)
	}
	// packages/core/src/client.ts offers exactly these flow IDs for gmessages.
	var flows []string
	for _, flow := range gm.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	if !slices.Equal(flows, []string{"google"}) {
		t.Errorf("login flows: got %v, want [google]", flows)
	}
}

// The HTTP client settings the bridge hands the connector (and libgm, through it) carry the
// send-once transport.
func TestGMessagesClientsSendOnce(t *testing.T) {
	conn, err := registry["gmessages"].New()
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHost(t, "gmessages", conn)
	settings := h.Bridge.GetHTTPClientSettings()
	for name, client := range map[string]*http.Client{
		"requests":  settings.Compile(),
		"long poll": settings.WithGlobalTimeout(30 * time.Minute).Compile(),
	} {
		if _, ok := client.Transport.(*gmessagesSendOnce); !ok {
			t.Errorf("%s client transport: got %T", name, client.Transport)
		}
	}
}

// googleServer stands in for a Google endpoint (Google Messages' relay, Google Voice). Each
// request is counted by path, and answered by answer.
type googleServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests map[string]int
}

func newGoogleServer(t *testing.T, answer http.HandlerFunc) *googleServer {
	srv := &googleServer{requests: map[string]int{}}
	srv.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv.mu.Lock()
		srv.requests[r.URL.Path]++
		srv.mu.Unlock()
		answer(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (srv *googleServer) total() int {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	n := 0
	for _, count := range srv.requests {
		n += count
	}
	return n
}

// RoundTrip sends a request meant for Google to the test server instead, keeping its path.
func (srv *googleServer) RoundTrip(req *http.Request) (*http.Response, error) {
	target, _ := url.Parse(srv.URL)
	out := req.Clone(req.Context())
	out.URL.Scheme, out.URL.Host, out.Host = target.Scheme, target.Host, ""
	return http.DefaultTransport.RoundTrip(out)
}

// newRelayClient is a libgm client whose requests go through the send-once transport to srv,
// built from the bridge's settings as the connector builds its own.
func newRelayClient(srv *googleServer) *libgm.Client {
	settings := exhttp.SensibleClientSettings
	settings.TransportOverride = func(exhttp.ClientSettings) http.RoundTripper {
		return (&gmessagesConnector{}).WrapHTTPTransport(srv)
	}
	return libgm.NewClient(libgm.NewAuthData(), nil, zerolog.Nop(), settings)
}

// libgm posts a request to the relay again after a 5xx, and the HTTP client follows a 307
// with the body. A send is posted once, and its ambiguous answer is an uncertain failure.
func TestGMessagesSendIsPostedOnce(t *testing.T) {
	for name, answer := range map[string]http.HandlerFunc{
		"server error": func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) },
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
		},
	} {
		t.Run(name, func(t *testing.T) {
			srv := newGoogleServer(t, answer)
			cli := newRelayClient(srv)
			_, err := cli.SendMessage(context.Background(), &gmproto.SendMessageRequest{ConversationID: "1"})
			var status bridgev2.MessageStatus
			if !errors.As(err, &status) || status.IsCertain {
				t.Fatalf("got %v, want an uncertain message status", err)
			}
			if n := srv.total(); n != 1 {
				t.Fatalf("the send reached the relay %d times (%v), want once", n, srv.requests)
			}
		})
	}
	t.Run("other requests keep their retries", func(t *testing.T) {
		srv := newGoogleServer(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) })
		cli := newRelayClient(srv)
		_, err := cli.GetParticipantThumbnail(context.Background(), "1")
		var status bridgev2.MessageStatus
		if err == nil || errors.As(err, &status) {
			t.Fatalf("got %v, want the relay's own error", err)
		}
		if n := srv.total(); n != libgm.ServerErrorMaxAttempts {
			t.Fatalf("a read reached the relay %d times, want %d", n, libgm.ServerErrorMaxAttempts)
		}
	})
}

// The Google account login begins with a cookie step, which needs no account to reach.
func TestGMessagesLoginStartsWithCookies(t *testing.T) {
	conn, err := registry["gmessages"].New()
	if err != nil {
		t.Fatal(err)
	}
	step := googleLoginFirstStep(t, "gmessages", conn, "google")
	if step.Type != protocol.StepCookies || step.Cookies == nil {
		t.Fatalf("first step: got %+v, want cookies", step)
	}
	if step.Cookies.URL != "https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config" {
		t.Errorf("cookie URL: %q", step.Cookies.URL)
	}
	required := map[string]bool{}
	for _, f := range step.Cookies.Fields {
		required[f.ID] = f.Required
	}
	want := map[string]bool{
		"SID": true, "HSID": true, "SSID": true, "APISID": true, "SAPISID": true, "OSID": true,
		"__Secure-1PSIDTS": false,
	}
	if len(required) != len(want) {
		t.Errorf("cookie fields: got %v, want %v", required, want)
	}
	for id, req := range want {
		if got, ok := required[id]; !ok || got != req {
			t.Errorf("cookie %s: present %v, required %v; want required %v", id, ok, got, req)
		}
	}
}

type idleClosingTransport struct {
	http.RoundTripper
	closed bool
}

func (t *idleClosingTransport) CloseIdleConnections() { t.closed = true }

// libgm drops idle connections on disconnect through http.Client.CloseIdleConnections, which
// only reaches the transport underneath if the send-once wrapper passes it on.
func TestGMessagesSendOnceClosesIdleConnections(t *testing.T) {
	inner := &idleClosingTransport{RoundTripper: http.DefaultTransport}
	(&http.Client{Transport: &gmessagesSendOnce{next: inner}}).CloseIdleConnections()
	if !inner.closed {
		t.Fatal("CloseIdleConnections didn't reach the wrapped transport")
	}
}

// A Google account login that fails before the emoji is logged with the step it stopped at,
// Google's status, endpoint and error number, and none of Google's words or the request's keys.
func TestGMessagesDescribeLoginError(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://messages.google.com/web/config?key=SECRETKEY", nil)
	if err != nil {
		t.Fatal(err)
	}
	httpErr := events.HTTPError{
		Resp: &http.Response{StatusCode: http.StatusUnauthorized, Request: req},
		Body: []byte("body about someone@example.com"),
	}
	reqErr := events.RequestError{HTTP: &httpErr, Data: &gmproto.ErrorResponse{Type: 16, Message: "someone@example.com isn't signed in"}}
	loginErr := fmt.Errorf("%w: %w", gmessages.ErrPairStartUnknown, fmt.Errorf("failed to fetch config: %w", reqErr))

	var buf bytes.Buffer
	log := zerolog.New(&buf)
	evt := log.Warn()
	(&gmessagesConnector{}).DescribeLoginError(evt, loginErr)
	evt.Send()

	for _, secret := range []string{"someone@example.com", "SECRETKEY", "signed in"} {
		if strings.Contains(buf.String(), secret) {
			t.Fatalf("the log line has %q: %s", secret, buf.String())
		}
	}
	var line struct {
		Steps     []string `json:"gm_steps"`
		Errors    []string `json:"gm_errors"`
		ErrorType int64    `json:"google_error_type"`
		Status    int      `json:"http_status"`
		Endpoint  string   `json:"http_endpoint"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(line.Steps, []string{"start_pairing", "fetch_config"}) {
		t.Errorf("gm_steps: %v", line.Steps)
	}
	if !slices.Equal(line.Errors, []string{"pair_start_unknown"}) {
		t.Errorf("gm_errors: %v", line.Errors)
	}
	if line.ErrorType != 16 || line.Status != http.StatusUnauthorized || line.Endpoint != "config" {
		t.Errorf("got google_error_type %d, http_status %d, http_endpoint %q", line.ErrorType, line.Status, line.Endpoint)
	}
}

// The phone-side failures libgm names are logged by name, with the step that failed.
func TestGMessagesDescribeLoginErrorNamesLibgmErrors(t *testing.T) {
	loginErr := fmt.Errorf("%w: %w", gmessages.ErrPairStartUnknown,
		fmt.Errorf("failed to send client init: %w", libgm.ErrPhoneNotResponding))
	var buf bytes.Buffer
	log := zerolog.New(&buf)
	evt := log.Warn()
	(&gmessagesConnector{}).DescribeLoginError(evt, loginErr)
	evt.Send()
	var line struct {
		Steps  []string `json:"gm_steps"`
		Errors []string `json:"gm_errors"`
	}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(line.Steps, []string{"start_pairing", "send_client_init"}) || !slices.Equal(line.Errors, []string{"pair_start_unknown", "phone_not_responding"}) {
		t.Errorf("got gm_steps %v, gm_errors %v", line.Steps, line.Errors)
	}
}

func describeGMessages(t *testing.T, err error) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	log := zerolog.New(&buf)
	evt := log.Warn()
	(&gmessagesConnector{}).DescribeLoginError(evt, err)
	evt.Send()
	line := map[string]any{}
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	return line
}

// A request that a redirect took somewhere else is logged without where: its path can name the
// account.
func TestGMessagesDescribeLoginErrorHidesUnknownEndpoints(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://accounts.google.com/someone@example.com/signin", nil)
	if err != nil {
		t.Fatal(err)
	}
	httpErr := events.HTTPError{Resp: &http.Response{StatusCode: http.StatusForbidden, Request: req}}
	line := describeGMessages(t, fmt.Errorf("%w: %w", gmessages.ErrPairStartUnknown, fmt.Errorf("failed to fetch config: %w", httpErr)))
	if line["http_endpoint"] != "other" || line["http_status"] != float64(http.StatusForbidden) {
		t.Errorf("got %v", line)
	}
}

// The connector replaces libgm's errors for the pairing failures it knows with its own; those
// are named, with the part of the login they end.
func TestGMessagesDescribeLoginErrorNamesConnectorErrors(t *testing.T) {
	line := describeGMessages(t, gmessages.ErrPairNoDevices)
	if fmt.Sprint(line["gm_errors"]) != "[no_devices_found]" || fmt.Sprint(line["gm_steps"]) != "[start_pairing]" {
		t.Errorf("got %v", line)
	}
	appended := gmessages.ErrPairStartUnknown.AppendMessage(": unexpected Google error %d", 7)
	line = describeGMessages(t, fmt.Errorf("%w (%w)", appended, events.RequestError{Data: &gmproto.ErrorResponse{Type: 7}}))
	if fmt.Sprint(line["gm_errors"]) != "[pair_start_unknown]" || line["google_error_type"] != float64(7) {
		t.Errorf("got %v", line)
	}
}

// Errors missing what libgm's own Error methods dereference are described without a panic.
func TestGMessagesDescribeLoginErrorOddShapes(t *testing.T) {
	var nilRequest *events.RequestError
	var nilHTTP *events.HTTPError
	for _, err := range []error{
		events.HTTPError{},
		events.RequestError{},
		events.RequestError{HTTP: &events.HTTPError{}},
		nilRequest,
		nilHTTP,
		fmt.Errorf("failed to fetch config: %w", events.RequestError{HTTP: &events.HTTPError{Resp: &http.Response{StatusCode: 500}}}),
	} {
		describeGMessages(t, fmt.Errorf("%w: %w", gmessages.ErrPairStartUnknown, err))
	}
}

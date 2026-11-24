package networks

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	"go.mau.fi/mautrix-linkedin/pkg/linkedingo"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// startSocialHost runs a bridge host for one network with no gateway, sealing to dev keys
// in a temporary directory, the way `bridge-host --dev-keys login` does.
func startSocialHost(t *testing.T, network string, conn bridgev2.NetworkConnector) *host.Host {
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
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return h
}

// socialFirstStep starts a login through the same command the gateway sends and returns
// the first step the host reports. The login is cancelled when the test ends.
func socialFirstStep(t *testing.T, h *host.Host, network, flowID string) *protocol.LoginStep {
	t.Helper()
	ctx := context.Background()
	session := "test-" + network + "-" + flowID
	from, err := h.Store.LastSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: "isaac",
		LoginSessionID: session, Network: network, FlowID: flowID,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = h.Connector.HandleCommand(ctx, &protocol.Command{
			CommandID: session + "-cancel", Type: protocol.CommandLoginCancel, UserID: "isaac", LoginSessionID: session,
		})
	})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		events, err := h.Store.After(ctx, from, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range events {
			from = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return evt.Step
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s %s: no login step", network, flowID)
	return nil
}

func hasLoginFlow(conn bridgev2.NetworkConnector, id string) bool {
	return slices.ContainsFunc(conn.GetLoginFlows(), func(f bridgev2.LoginFlow) bool { return f.ID == id })
}

func TestLinkedInConnector(t *testing.T) {
	network, _ := Lookup("linkedin")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	wrapped, ok := conn.(*linkedinConnector)
	if !ok {
		t.Fatalf("connector: got %T", conn)
	}
	li := wrapped.LinkedInConnector
	if li.Config.LogRedactedLoginResponses {
		t.Error("login responses would be logged")
	}
	if li.Config.Sync.CreateLimit <= 0 {
		t.Errorf("sync create limit %d: the example config's defaults weren't loaded", li.Config.Sync.CreateLimit)
	}
	if got := li.Config.FormatDisplayname(linkedin.DisplaynameParams{FirstName: "Ada", LastName: "Lovelace"}); got != "Ada Lovelace" {
		t.Errorf("contact name %q, want %q", got, "Ada Lovelace")
	}
	if got := li.Config.FormatDisplayname(linkedin.DisplaynameParams{Organization: "Analytical Engines"}); got != "Analytical Engines" {
		t.Errorf("organization name %q", got)
	}
	// packages/core offers the cookie flow by this ID.
	if !hasLoginFlow(conn, "cookies") {
		t.Fatalf("no cookies flow in %+v", conn.GetLoginFlows())
	}

	h := startSocialHost(t, "linkedin", conn)
	step := socialFirstStep(t, h, "linkedin", "cookies")
	if step.Type != protocol.StepCookies || step.Cookies == nil || !strings.HasPrefix(step.Cookies.URL, "https://linkedin.com/") {
		t.Fatalf("first step: %+v", step)
	}
	required := map[string]bool{}
	for _, f := range step.Cookies.Fields {
		required[f.ID] = f.Required
	}
	// The cookie header and the two LinkedIn headers are needed; the browser headers are
	// optional (Firefox sends no Sec-Ch-Ua headers at all), so the app must not insist on them.
	for id, want := range map[string]bool{
		"fi.mau.linkedin.login.cookie_header":             true,
		"fi.mau.linkedin.login.x_li_track":                true,
		"fi.mau.linkedin.login.x_li_page_instance":        true,
		"fi.mau.linkedin.login.header.user-agent":         false,
		"fi.mau.linkedin.login.header.sec-ch-ua":          false,
		"fi.mau.linkedin.login.header.sec-ch-ua-platform": false,
	} {
		if got, ok := required[id]; !ok || got != want {
			t.Errorf("cookie field %s: present %v, required %v, want required %v", id, ok, got, want)
		}
	}
}

// Wrapping the connector mustn't hide what bridgev2 looks for on it: each optional interface
// mautrix-linkedin's connector implements, the wrapper implements too.
func TestLinkedInWrapperKeepsInterfaces(t *testing.T) {
	conn, err := registry["linkedin"].New()
	if err != nil {
		t.Fatal(err)
	}
	inner := conn.(*linkedinConnector).LinkedInConnector
	for _, iface := range []reflect.Type{
		reflect.TypeFor[bridgev2.StoppableNetwork](),
		reflect.TypeFor[bridgev2.DirectMediableNetwork](),
		reflect.TypeFor[bridgev2.IdentifierValidatingNetwork](),
		reflect.TypeFor[bridgev2.TransactionIDGeneratingNetwork](),
		reflect.TypeFor[bridgev2.PortalBridgeInfoFillingNetwork](),
		reflect.TypeFor[bridgev2.ConfigValidatingNetwork](),
		reflect.TypeFor[bridgev2.MaxFileSizeingNetwork](),
		reflect.TypeFor[bridgev2.NetworkResettingNetwork](),
		reflect.TypeFor[bridgev2.SplitPortalMigratingNetwork](),
		reflect.TypeFor[bridgev2.PushParsingNetwork](),
	} {
		if reflect.TypeOf(inner).Implements(iface) && !reflect.TypeOf(conn).Implements(iface) {
			t.Errorf("the wrapper hides %s", iface)
		}
	}
	// The connector asserts these three itself.
	if _, ok := conn.(bridgev2.DirectMediableNetwork); !ok {
		t.Error("the wrapper hides DirectMediableNetwork")
	}
	if _, ok := conn.(bridgev2.IdentifierValidatingNetwork); !ok {
		t.Error("the wrapper hides IdentifierValidatingNetwork")
	}
	if _, ok := conn.(bridgev2.TransactionIDGeneratingNetwork); !ok {
		t.Error("the wrapper hides TransactionIDGeneratingNetwork")
	}
}

// loadLinkedInLogin loads a login the way bridgev2 does, through the wrapper, and points the
// send-once transport at linkedIn instead of the network.
func loadLinkedInLogin(t *testing.T, linkedIn http.RoundTripper) *linkedin.LinkedInClient {
	t.Helper()
	conn, err := registry["linkedin"].New()
	if err != nil {
		t.Fatal(err)
	}
	jar, err := linkedingo.NewJarFromCookieHeader("JSESSIONID=ajax:1; li_at=x")
	if err != nil {
		t.Fatal(err)
	}
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{ID: "me", Metadata: &linkedin.UserLoginMetadata{Cookies: jar}}}
	if err = conn.LoadUserLogin(context.Background(), login); err != nil {
		t.Fatal(err)
	}
	client := login.Client.(*linkedin.LinkedInClient)
	httpClient, err := linkedinHTTPClient(client)
	if err != nil {
		t.Fatal(err)
	}
	sendOnce, ok := httpClient.Transport.(*linkedinSendOnce)
	if !ok {
		t.Fatalf("login transport: got %T", httpClient.Transport)
	}
	sendOnce.next = linkedIn
	return client
}

// The reflection that installs the transport fails loudly, not silently, if an upgrade
// moves or retypes the fields it reads: loading a login then fails, and so does this test.
func TestLinkedInSendOnceReachesTheClient(t *testing.T) {
	loadLinkedInLogin(t, &countingTransport{fail: status(http.StatusOK)})
	if _, err := privateField[*http.Client](&linkedingo.Client{}, "jar"); err == nil {
		t.Error("a field of another type was read")
	}
	if _, err := privateField[*http.Client](&linkedingo.Client{}, "missing"); err == nil {
		t.Error("a missing field was read")
	}
}

// linkedinSend sends a text through the connector. The timeout is shorter than DoRaw's
// retries take (2s, 4s, 8s...), so a send that is repeated fails the test quickly.
func linkedinSend(client *linkedin.LinkedInClient) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.HandleMatrixMessage(ctx, &bridgev2.MatrixMessage{
		MatrixEventBase: bridgev2.MatrixEventBase[*event.MessageEventContent]{
			Event:              &event.Event{ID: "$send", RoomID: "!chat"},
			Content:            &event.MessageEventContent{MsgType: event.MsgText, Body: "hello"},
			Portal:             &bridgev2.Portal{Portal: &database.Portal{PortalKey: networkid.PortalKey{ID: "2-abc", Receiver: "me"}}},
			InputTransactionID: "txn-1",
		},
	})
	return err
}

// DoRaw repeats a request after a transport error or a 502/503/504, and doesn't follow a
// redirect. A message must go out once and, when its outcome is ambiguous, be reported as
// uncertain, which the bridge host records as unknown.
func TestLinkedInSendIsNotRepeated(t *testing.T) {
	for name, fail := range map[string]func(*http.Request) (*http.Response, error){
		"transport error":     func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset") },
		"bad gateway":         status(http.StatusBadGateway),
		"service unavailable": status(http.StatusServiceUnavailable),
		"gateway timeout":     status(http.StatusGatewayTimeout),
		"redirect":            status(http.StatusSeeOther),
	} {
		t.Run(name, func(t *testing.T) {
			linkedIn := &countingTransport{fail: fail}
			err := linkedinSend(loadLinkedInLogin(t, linkedIn))
			var ms bridgev2.MessageStatus
			if !errors.As(err, &ms) {
				t.Fatalf("got %v, want a message status", err)
			}
			if ms.IsCertain || ms.Status == event.MessageStatusFail {
				t.Errorf("status %+v: reported as certain", ms)
			}
			if n := linkedIn.calls.Load(); n != 1 {
				t.Fatalf("the message reached LinkedIn %d times, want once", n)
			}
		})
	}
	t.Run("refusal stays certain", func(t *testing.T) {
		linkedIn := &countingTransport{fail: status(http.StatusBadRequest)}
		err := linkedinSend(loadLinkedInLogin(t, linkedIn))
		var ms bridgev2.MessageStatus
		if !errors.As(err, &ms) || !ms.IsCertain {
			t.Fatalf("got %v, want a certain failure", err)
		}
		if n := linkedIn.calls.Load(); n != 1 {
			t.Fatalf("the message reached LinkedIn %d times, want once", n)
		}
	})
}

// An edit or a deletion reaches LinkedIn once even when its outcome is ambiguous: repeated, an
// edit could overwrite a newer one made on the phone meanwhile. A refusal stays LinkedIn's own.
func TestLinkedInEditAndRecallAreNotRepeated(t *testing.T) {
	message := linkedingo.NewURN("urn:li:msg_message:1")
	for name, change := range map[string]func(*linkedingo.Client) error{
		"edit": func(cli *linkedingo.Client) error {
			return cli.EditMessage(context.Background(), message, linkedingo.SendMessageBody{Text: "edited"})
		},
		"recall": func(cli *linkedingo.Client) error { return cli.RecallMessage(context.Background(), message) },
	} {
		for _, code := range []int{http.StatusBadGateway, http.StatusTeapot} {
			t.Run(fmt.Sprintf("%s %d", name, code), func(t *testing.T) {
				linkedIn := &countingTransport{fail: status(code)}
				cli := linkedingo.NewClient(context.Background(), linkedingo.NewURN("me"), linkedingo.NewEmptyStringCookieJar(), "", "", "", linkedingo.Handlers{})
				httpClient, err := linkedingoHTTPClient(cli)
				if err != nil {
					t.Fatal(err)
				}
				httpClient.Transport = &linkedinSendOnce{next: linkedIn}
				err = change(cli)
				var respErr *linkedingo.ResponseError
				want := code
				if code >= 500 {
					want = http.StatusInternalServerError
				}
				if !errors.As(err, &respErr) || respErr.StatusCode != want {
					t.Fatalf("got %v, want a %d", err, want)
				}
				if n := linkedIn.calls.Load(); n != 1 {
					t.Fatalf("it reached LinkedIn %d times, want once", n)
				}
			})
		}
	}
}

// Other requests keep DoRaw's retries: only creating, editing and deleting messages and
// reactions are changed.
func TestLinkedInOtherRequestsPassThrough(t *testing.T) {
	sendOnce := &linkedinSendOnce{next: &countingTransport{fail: status(http.StatusBadGateway)}}
	for _, target := range []string{
		"https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=markAllRead",
		"https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?action=typing",
	} {
		req, _ := http.NewRequest(http.MethodPost, target, nil)
		resp, err := sendOnce.RoundTrip(req)
		if err != nil || resp.StatusCode != http.StatusBadGateway {
			t.Errorf("%s: got %v %v, want the 502 untouched", target, resp, err)
		}
	}
}

// A reaction, added or taken away, reaches LinkedIn once even when its outcome is ambiguous:
// repeated, it could undo what the person did meanwhile on another device.
func TestLinkedInReactionIsNotRepeated(t *testing.T) {
	for name, react := range map[string]func(*linkedingo.Client) error{
		"add": func(cli *linkedingo.Client) error {
			return cli.SendReaction(context.Background(), linkedingo.NewURN("urn:li:msg_message:1"), "👍")
		},
		"remove": func(cli *linkedingo.Client) error {
			return cli.RemoveReaction(context.Background(), linkedingo.NewURN("urn:li:msg_message:1"), "👍")
		},
	} {
		t.Run(name, func(t *testing.T) {
			linkedIn := &countingTransport{fail: status(http.StatusBadGateway)}
			cli := linkedingo.NewClient(context.Background(), linkedingo.NewURN("me"), linkedingo.NewEmptyStringCookieJar(), "", "", "", linkedingo.Handlers{})
			httpClient, err := linkedingoHTTPClient(cli)
			if err != nil {
				t.Fatal(err)
			}
			httpClient.Transport = &linkedinSendOnce{next: linkedIn}
			if err := react(cli); err == nil {
				t.Fatal("an ambiguous reaction was reported as done")
			}
			if n := linkedIn.calls.Load(); n != 1 {
				t.Fatalf("the reaction reached LinkedIn %d times, want once", n)
			}
		})
	}
}

// A signed-out session's cookies reach the jar even when the answer to a send is replaced.
func TestLinkedInSendOnceKeepsCookies(t *testing.T) {
	sendOnce := &linkedinSendOnce{next: &countingTransport{fail: func(req *http.Request) (*http.Response, error) {
		resp, _ := status(http.StatusFound)(req)
		resp.Header.Add("Set-Cookie", "li_at=delete me; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
		return resp, nil
	}}}
	req, _ := http.NewRequest(http.MethodPost, "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage", nil)
	resp, err := sendOnce.RoundTrip(req)
	if err != nil || resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("got %v %v, want a 500", resp, err)
	}
	if got := resp.Header.Values("Set-Cookie"); len(got) != 1 || !strings.HasPrefix(got[0], "li_at=delete me") {
		t.Errorf("cookies: got %q", got)
	}
}

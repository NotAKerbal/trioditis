package networks

import (
	"context"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	gvoice "go.mau.fi/mautrix-gvoice/pkg/connector"
	"go.mau.fi/mautrix-gvoice/pkg/libgv"
	"go.mau.fi/mautrix-gvoice/pkg/libgv/gvproto"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func TestGVoiceConnector(t *testing.T) {
	conn, err := registry["gvoice"].New()
	if err != nil {
		t.Fatal(err)
	}
	gv, ok := conn.(*gvoiceConnector)
	if !ok {
		t.Fatalf("connector: got %T", conn)
	}
	if gv.Config.InitialThreadSyncCount != 20 || gv.Config.DisplaynameTemplate == "" {
		t.Errorf("example defaults not loaded: %+v", gv.Config)
	}
	// Wrapping it mustn't hide what bridgev2 looks for on the connector.
	if _, ok := conn.(bridgev2.DirectMediableNetwork); !ok {
		t.Error("the wrapper hides DirectMediableNetwork")
	}
	var flows []string
	for _, flow := range gv.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	if !slices.Equal(flows, []string{"cookies"}) {
		t.Errorf("login flows: got %v, want [cookies]", flows)
	}
}

func TestGVoiceLoginStartsWithCookies(t *testing.T) {
	conn, err := registry["gvoice"].New()
	if err != nil {
		t.Fatal(err)
	}
	step := googleLoginFirstStep(t, "gvoice", conn, "cookies")
	if step.Type != protocol.StepCookies || step.Cookies == nil {
		t.Fatalf("first step: got %+v, want cookies", step)
	}
	if step.Cookies.URL != "https://voice.google.com/signup" {
		t.Errorf("cookie URL: %q", step.Cookies.URL)
	}
	required := map[string]bool{}
	for _, f := range step.Cookies.Fields {
		required[f.ID] = f.Required
	}
	want := map[string]bool{
		"SID": true, "HSID": true, "SSID": true, "APISID": true, "SAPISID": true,
		"OSID": false, "COMPASS": false, "__Secure-1PSIDTS": false,
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

// countingTransport stands in for Google: it counts requests and answers each with fail.
type countingTransport struct {
	calls atomic.Int32
	fail  func(*http.Request) (*http.Response, error)
}

func (c *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return c.fail(req)
}

func status(code int) func(*http.Request) (*http.Response, error) {
	return func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	}
}

// libgv repeats a request after a network error or a 5xx. A send must go out once: an
// ambiguous failure comes back as a 408, which the connector reports as uncertain.
func TestGVoiceSendIsNotRepeated(t *testing.T) {
	for name, fail := range map[string]func(*http.Request) (*http.Response, error){
		"transport error": func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset") },
		"server error":    status(http.StatusBadGateway),
	} {
		t.Run(name, func(t *testing.T) {
			google := &countingTransport{fail: fail}
			cli := libgv.NewClient(map[string]string{"SAPISID": "x"})
			cli.HTTP.Transport = &gvoiceSendOnce{next: google}
			_, err := cli.SendMessage(context.Background(), &gvproto.ReqSendSMS{ThreadID: "t.+15550100", Text: "hello"})
			var respErr *libgv.ResponseError
			if !errors.As(err, &respErr) || respErr.Resp.StatusCode != http.StatusRequestTimeout {
				t.Fatalf("got %v, want a 408 response error", err)
			}
			if n := google.calls.Load(); n != 1 {
				t.Fatalf("the send reached Google %d times, want once", n)
			}
		})
	}
	// The HTTP client would follow a 307 by posting the text again, to a path the send
	// endpoint match no longer covers; a 5xx there would then be retried by libgv.
	t.Run("redirect", func(t *testing.T) {
		google := newGoogleServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == gvoiceSendSMS.Path {
				http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
				return
			}
			w.WriteHeader(http.StatusBadGateway)
		})
		cli := libgv.NewClient(map[string]string{"SAPISID": "x"})
		cli.HTTP.Transport = &gvoiceSendOnce{next: google}
		_, err := cli.SendMessage(context.Background(), &gvproto.ReqSendSMS{ThreadID: "t.+15550100", Text: "hello"})
		var respErr *libgv.ResponseError
		if !errors.As(err, &respErr) || respErr.Resp.StatusCode != http.StatusRequestTimeout {
			t.Fatalf("got %v, want a 408 response error", err)
		}
		if n := google.total(); n != 1 {
			t.Fatalf("the send reached Google %d times (%v), want once", n, google.requests)
		}
	})
	t.Run("other requests pass through", func(t *testing.T) {
		google := &countingTransport{fail: status(http.StatusTeapot)}
		cli := libgv.NewClient(map[string]string{"SAPISID": "x"})
		cli.HTTP.Transport = &gvoiceSendOnce{next: google}
		_, err := cli.GetAccount(context.Background())
		var respErr *libgv.ResponseError
		if !errors.As(err, &respErr) || respErr.Resp.StatusCode != http.StatusTeapot {
			t.Fatalf("got %v, want the server's own 418", err)
		}
	})
}

// Every login's client gets the send-once transport, whichever way it is loaded.
func TestGVoiceLoginsSendOnce(t *testing.T) {
	conn, err := registry["gvoice"].New()
	if err != nil {
		t.Fatal(err)
	}
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{Metadata: &gvoice.UserLoginMetadata{Cookies: map[string]string{"SAPISID": "x"}}}}
	if err = conn.LoadUserLogin(context.Background(), login); err != nil {
		t.Fatal(err)
	}
	client := login.Client.(*gvoice.GVClient)
	if _, ok := client.Client.HTTP.Transport.(*gvoiceSendOnce); !ok {
		t.Fatalf("login transport: got %T", client.Client.HTTP.Transport)
	}
}

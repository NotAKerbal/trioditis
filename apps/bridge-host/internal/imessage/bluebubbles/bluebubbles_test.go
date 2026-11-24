package bluebubbles

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func allowAll(netip.Addr) bool { return true }

func TestParseServerURL(t *testing.T) {
	for in, want := range map[string]string{
		"192.168.1.20:1234":             "http://192.168.1.20:1234",
		" http://mac.local:1234/ ":      "http://mac.local:1234",
		"https://abc.trycloudflare.com": "https://abc.trycloudflare.com",
		"https://example.com/bb/?x=1#y": "https://example.com/bb",
	} {
		u, err := ParseServerURL(in)
		if err != nil || u.String() != want {
			t.Errorf("ParseServerURL(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
	for _, in := range []string{"", "ftp://mac:1234", "http://", "http://user:pw@mac:1234"} {
		if _, err := ParseServerURL(in); err == nil {
			t.Errorf("ParseServerURL(%q) took it", in)
		}
	}
}

// A Mac is on the person's network, a tailnet or a tunnel; the bridge host itself, the
// machine it runs on and the clouds' metadata services are never one.
func TestAddressPolicy(t *testing.T) {
	own := []netip.Prefix{netip.MustParsePrefix("172.18.0.0/16")}
	for addr, want := range map[string]bool{
		"192.168.1.20":           true,
		"10.0.0.5":               true,
		"100.101.102.103":        true, // Tailscale
		"fd7a:115c:a1e0::1":      true, // Tailscale over IPv6
		"203.0.114.7":            true,
		"127.0.0.1":              false,
		"::1":                    false,
		"0.0.0.0":                false,
		"169.254.169.254":        false,
		"fe80::1":                false,
		"fd00:ec2::254":          false,
		"100.100.100.200":        false,
		"168.63.129.16":          false,
		"224.0.0.1":              false,
		"255.255.255.255":        false,
		"172.18.0.4":             false, // the container's own network
		"::ffff:127.0.0.1":       false,
		"::ffff:192.168.1.20":    true,
		"::ffff:169.254.169.254": false,
	} {
		if got := addressAllowed(netip.MustParseAddr(addr), own); got != want {
			t.Errorf("%s allowed: %v, want %v", addr, got, want)
		}
	}
}

// The default policy refuses the server's own loopback, and the error says so without the
// password the URL carries.
func TestLoopbackRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request reached the server")
	}))
	defer srv.Close()
	c, err := New(srv.URL, "hunter2", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.ServerInfo(context.Background())
	if !errors.Is(err, ErrAddressRefused) {
		t.Fatalf("got %v, want the address refused", err)
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Errorf("the error quotes the password: %v", err)
	}
	err = c.Listen(context.Background(), nil, func(Event) {})
	if !errors.Is(err, ErrAddressRefused) || strings.Contains(err.Error(), "hunter2") {
		t.Errorf("socket: got %v, want the address refused without the password", err)
	}
}

func reply(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// A send is made once, whatever comes back, and a redirect isn't followed (the client would
// post the same body again). How certain each failure is decides failed against unknown.
func TestSendOutcomes(t *testing.T) {
	var posts atomic.Int32
	var answer atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("password") != "pw" {
			reply(w, 401, `{"status":401,"error":{"type":"Authentication Error","message":"Unauthorized"}}`)
			return
		}
		if r.Method != http.MethodPost {
			reply(w, 200, `{"status":200,"data":{}}`)
			return
		}
		posts.Add(1)
		answer.Load().(func(http.ResponseWriter, *http.Request))(w, r)
	}))
	defer srv.Close()
	c, err := New(srv.URL, "pw", allowAll)
	if err != nil {
		t.Fatal(err)
	}
	send := func() error {
		_, err := c.SendText(context.Background(), TextMessage{ChatGUID: "iMessage;-;+15550001111", TempGUID: "t", Message: "hi", Method: MethodAppleScript})
		return err
	}
	cases := []struct {
		name            string
		answer          func(http.ResponseWriter, *http.Request)
		certain, needsP bool
		failed          bool
	}{
		{"validation", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 400, `{"status":400,"error":{"type":"Validation Error","message":"The chat guid field is required."}}`)
		}, true, false, false},
		{"no such chat", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 404, `{"status":404,"error":{"type":"Database Error","message":"Chat does not exist!"}}`)
		}, true, false, false},
		{"private api off", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"error":{"type":"iMessage Error","message":"iMessage Private API is not enabled!"}}`)
		}, true, true, false},
		{"marked failed", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message sent with an error. See attached message","error":{"type":"iMessage Error","message":"Message failed to send!"},"data":{"guid":"G","error":22}}`)
		}, true, false, true},
		{"timed out waiting", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message Send Error","error":{"type":"iMessage Error","message":"Failed to send message! See attached message error code."},"data":null}`)
		}, false, false, false},
		{"unhandled", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"error":{"type":"Server Error","message":"boom"}}`)
		}, false, false, false},
		{"gateway timeout", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 504, `{"status":504,"error":{"type":"Gateway Timeout","message":"slow"}}`)
		}, false, false, false},
		{"redirect", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
		}, false, false, false},
	}
	for _, tc := range cases {
		posts.Store(0)
		answer.Store(tc.answer)
		err := send()
		var bbErr *Error
		if !errors.As(err, &bbErr) {
			t.Errorf("%s: got %v, want a server error", tc.name, err)
			continue
		}
		if n := posts.Load(); n != 1 {
			t.Errorf("%s: posted %d times, want once", tc.name, n)
		}
		if bbErr.Certain() != tc.certain || bbErr.NeedsPrivateAPI() != tc.needsP || (bbErr.Failed != nil) != tc.failed {
			t.Errorf("%s: certain %v, needs Private API %v, failed %v", tc.name, bbErr.Certain(), bbErr.NeedsPrivateAPI(), bbErr.Failed != nil)
		}
		if strings.Contains(err.Error(), "boom") || strings.Contains(err.Error(), "pw") {
			t.Errorf("%s: the error quotes the server or the password: %v", tc.name, err)
		}
	}

	answer.Store(func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, `{"status":200,"message":"Message sent!","data":{"guid":"SENT","dateCreated":1700000000000,"isFromMe":true,"tempGuid":"t"}}`)
	})
	msg, err := c.SendText(context.Background(), TextMessage{ChatGUID: "c", TempGUID: "t", Message: "hi", Method: MethodAppleScript})
	if err != nil || msg.GUID != "SENT" || msg.DateCreated != 1700000000000 {
		t.Fatalf("a send that went: %+v, %v", msg, err)
	}

	bad, err := New(srv.URL, "wrong", allowAll)
	if err != nil {
		t.Fatal(err)
	}
	_, err = bad.ServerInfo(context.Background())
	var bbErr *Error
	if !errors.As(err, &bbErr) || !bbErr.Unauthorized() {
		t.Errorf("a wrong password: %v", err)
	}
}

func TestTapbackType(t *testing.T) {
	for raw, want := range map[string]string{
		`"love"`: "love", `"-like"`: "-like", `"2006"`: "emoji", `"3006"`: "-emoji", `2003`: "laugh",
		`"sticker"`: "sticker", `null`: "",
	} {
		m := Message{AssociatedMessageGUID: "p:0/X", AssociatedMessageType: json.RawMessage(raw)}
		if got := m.TapbackType(); got != want {
			t.Errorf("TapbackType(%s) = %q, want %q", raw, got, want)
		}
	}
	m := Message{AssociatedMessageType: json.RawMessage(`"love"`)}
	if m.TapbackType() != "" {
		t.Error("a tapback type with no target counted")
	}
}

// The socket speaks Engine.IO 4: it answers the server's pings, joins the default namespace,
// and hands over events in order; a refused connection ends saying so.
func TestListen(t *testing.T) {
	var gotPassword atomic.Value
	refuse := atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPassword.Store(r.URL.Query().Get("password"))
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`0{"sid":"s","pingInterval":25000,"pingTimeout":20000}`))
		if _, data, err := conn.Read(ctx); err != nil || string(data) != "40" {
			t.Errorf("join: %q, %v", data, err)
			return
		}
		if refuse.Load() {
			_ = conn.Write(ctx, websocket.MessageText, []byte(`44{"message":"Authentication failed"}`))
			return
		}
		_ = conn.Write(ctx, websocket.MessageText, []byte(`40{"sid":"x"}`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`2`))
		if _, data, err := conn.Read(ctx); err != nil || string(data) != "3" {
			t.Errorf("pong: %q, %v", data, err)
			return
		}
		_ = conn.Write(ctx, websocket.MessageText, []byte(`42["new-message",{"guid":"A"}]`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`42["typing-indicator",{"display":true,"guid":"c"}]`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`41`))
	}))
	defer srv.Close()
	c, err := New(srv.URL, "p@ss word", allowAll)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connected := false
	var events []Event
	err = c.Listen(ctx, func() { connected = true }, func(e Event) { events = append(events, e) })
	if err == nil || !connected {
		t.Fatalf("Listen: %v, connected %v", err, connected)
	}
	if gotPassword.Load() != "p@ss word" {
		t.Errorf("the socket's password: %q", gotPassword.Load())
	}
	if len(events) != 2 || events[0].Name != "new-message" || string(events[0].Data) != `{"guid":"A"}` || events[1].Name != "typing-indicator" {
		t.Errorf("events: %+v", events)
	}

	refuse.Store(true)
	if err = c.Listen(ctx, nil, func(Event) {}); !errors.Is(err, ErrSocketRefused) {
		t.Errorf("refused: %v", err)
	}
}

func TestParseEvent(t *testing.T) {
	if e, ok := parseEvent([]byte(`12["x",{"a":1}]`)); !ok || e.Name != "x" || string(e.Data) != `{"a":1}` {
		t.Errorf("with an ack ID: %+v %v", e, ok)
	}
	for _, bad := range []string{``, `["x"`, `ab["x"]`, `[1]`, `[]`} {
		if _, ok := parseEvent([]byte(bad)); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

package bluebubbles

import (
	"context"
	"encoding/json"
	"errors"
	"net"
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

func envelope404(w http.ResponseWriter) {
	reply(w, 404, `{"status":404,"error":{"type":"Database Error","message":"Chat does not exist!"}}`)
}

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

// By default a Mac may only be on the public internet; the operator opens private ranges.
// The bridge host itself, the machine it runs on and the clouds' metadata services never
// open, whatever is listed.
func TestAddressPolicy(t *testing.T) {
	own := func() []netip.Prefix { return []netip.Prefix{netip.MustParsePrefix("172.18.0.0/16")} }
	public := Policy{Own: own}
	listed := Policy{
		Allowed: []netip.Prefix{netip.MustParsePrefix("192.168.1.0/24"), netip.MustParsePrefix("100.64.0.0/10"),
			netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("127.0.0.0/8")},
		Deny: []netip.Prefix{netip.MustParsePrefix("192.168.1.1/32")},
		Own:  own,
	}
	for addr, want := range map[string][2]bool{ // [public only, with the listing]
		"203.0.114.7":            {true, true},
		"2606:4700::1":           {true, true},
		"192.168.1.20":           {false, true},
		"192.168.2.20":           {false, false},
		"10.0.0.5":               {false, false},
		"100.101.102.103":        {false, true},  // Tailscale
		"192.168.1.1":            {false, false}, // denied by the operator
		"172.18.0.4":             {false, false}, // the container's own network
		"127.0.0.1":              {false, false},
		"::1":                    {false, false},
		"0.0.0.0":                {false, false},
		"169.254.169.254":        {false, false},
		"fe80::1":                {false, false},
		"fd00:ec2::254":          {false, false},
		"100.100.100.200":        {false, false},
		"168.63.129.16":          {false, false},
		"224.0.0.1":              {false, false},
		"255.255.255.255":        {false, false},
		"::ffff:127.0.0.1":       {false, false},
		"::ffff:192.168.1.20":    {false, true},
		"::ffff:169.254.169.254": {false, false},
		"fd7a:115c:a1e0::1":      {false, false},
	} {
		a := netip.MustParseAddr(addr)
		if got := [2]bool{public.Allows(a), listed.Allows(a)}; got != want {
			t.Errorf("%s allowed: %v, want %v", addr, got, want)
		}
	}
	if p, err := ParseNetworks(" 192.168.1.0/24, 100.64.0.0/10 ,10.0.0.7"); err != nil || len(p) != 3 || p[2].Bits() != 32 {
		t.Errorf("ParseNetworks: %v, %v", p, err)
	}
	if _, err := ParseNetworks("192.168.1.0/24,nonsense"); err == nil {
		t.Error("ParseNetworks took nonsense")
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
		{"no such chat", func(w http.ResponseWriter, r *http.Request) { envelope404(w) }, true, false, false},
		{"private api off", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"error":{"type":"iMessage Error","message":"iMessage Private API is not enabled!"}}`)
		}, true, true, false},
		{"helper not connected", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"error":{"type":"iMessage Error","message":"iMessage Private API Helper is not connected!"}}`)
		}, true, true, false},
		{"marked failed", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message sent with an error. See attached message","error":{"type":"iMessage Error","message":"Message failed to send!"},"data":{"guid":"G","error":22}}`)
		}, true, false, true},
		{"rejected with its message", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message Send Error","error":{"type":"iMessage Error","message":"Failed to send message! See attached message error code."},"data":{"guid":"G","error":4}}`)
		}, true, false, true},
		{"timed out waiting", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message Send Error","error":{"type":"iMessage Error","message":"Failed to send message! Message not found in database after 60 seconds!"},"data":null}`)
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
		// A proxy in front can answer after passing the send on: its 4xx isn't the server's.
		{"proxy's 4xx", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(499)
			_, _ = w.Write([]byte("<html>client closed request</html>"))
		}, false, false, false},
		{"envelope with another status", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 400, `{"status":500,"error":{"type":"Validation Error","message":"x"}}`)
		}, false, false, false},
		{"marked failed, rethrown without its message", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"Message Send Error","error":{"type":"iMessage Error","message":"[500] Message sent with an error. See attached message"}}`)
		}, true, false, true},
		{"helper refused by chat/new", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"message":"An unhandled error has occurred!","error":{"type":"Server Error","message":"iMessage Private API Helper is not connected!"}}`)
		}, true, true, false},
		{"what a proxy writes into the type", func(w http.ResponseWriter, r *http.Request) {
			reply(w, 500, `{"status":500,"error":{"type":"hi from the person pw","message":"boom"}}`)
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
		if bbErr.Certain() != tc.certain || bbErr.NeedsPrivateAPI() != tc.needsP || bbErr.MarkedFailed() != tc.failed {
			t.Errorf("%s: certain %v, needs Private API %v, failed %v", tc.name, bbErr.Certain(), bbErr.NeedsPrivateAPI(), bbErr.MarkedFailed())
		}
		if strings.Contains(err.Error(), "boom") || strings.Contains(err.Error(), "pw") || strings.Contains(err.Error(), "hi from") {
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

// Newer macOS versions mark an unsend as an edit that took back every part.
func TestUnsent(t *testing.T) {
	zero, one := 0, 1
	for name, tc := range map[string]struct {
		msg  Message
		want bool
	}{
		"retracted":             {Message{DateRetracted: 5}, true},
		"every part taken back": {Message{DateEdited: 5, PartCount: &zero, MessageSummaryInfo: json.RawMessage(`[{"retractedParts":[0]}]`)}, true},
		"no summary, no parts":  {Message{DateEdited: 5, PartCount: &zero}, true},
		"one part left":         {Message{DateEdited: 5, PartCount: &one, MessageSummaryInfo: json.RawMessage(`[{"retractedParts":[0]}]`)}, false},
		"only edited":           {Message{DateEdited: 5, PartCount: &one}, false},
		"no part count":         {Message{DateEdited: 5}, false},
		"plain":                 {Message{}, false},
	} {
		if got := tc.msg.Unsent(); got != tc.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}

// What comes back over a broken connection can be anything, the person's words included, and
// the request's address carries the password: neither reaches an error's text.
func TestTransportErrorsSayFixedWords(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			buf := make([]byte, 4096)
			_, _ = conn.Read(buf)
			_, _ = conn.Write([]byte("HTTP/1.1 2x0 meet me at noon\r\n\r\n"))
			_ = conn.Close()
		}
	}()
	c, err := New("http://"+ln.Addr().String(), "s3cret", allowAll)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.SendText(context.Background(), TextMessage{ChatGUID: "c", TempGUID: "t", Message: "meet me at noon", Method: MethodPrivateAPI})
	var tErr *TransportError
	if !errors.As(err, &tErr) || tErr.NotSent() {
		t.Fatalf("got %v, want a transport error after sending", err)
	}
	if strings.Contains(err.Error(), "noon") || strings.Contains(err.Error(), "s3cret") {
		t.Errorf("the error quotes what came back or the password: %v", err)
	}

	// A connection that never opens sent nothing.
	addr := ln.Addr().String()
	ln.Close()
	_, err = c.SendText(context.Background(), TextMessage{ChatGUID: "c", TempGUID: "t", Message: "x", Method: MethodPrivateAPI})
	if !errors.As(err, &tErr) || !tErr.NotSent() || strings.Contains(err.Error(), addr) {
		t.Errorf("a refused connection: %v", err)
	}
}

// A certificate is refused in the handshake, before any of the request goes.
func TestCertificateRefusedIsNotSent(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the request reached the server")
	}))
	defer srv.Close()
	c, err := New(srv.URL, "pw", allowAll)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.SendText(context.Background(), TextMessage{ChatGUID: "c", TempGUID: "t", Message: "x", Method: MethodPrivateAPI})
	var tErr *TransportError
	if !errors.As(err, &tErr) || !tErr.NotSent() {
		t.Errorf("a refused certificate: %v", err)
	}
}

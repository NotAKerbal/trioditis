package networks

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	bluesky "go.mau.fi/mautrix-bluesky/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func TestBlueskyConnector(t *testing.T) {
	network, _ := Lookup("bluesky")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	bs := conn.(*blueskyConnector)
	if got := bs.Config.FormatDisplayname("", "ada.bsky.social", "did:plc:x"); got != "ada.bsky.social" {
		t.Errorf("contact with no display name: %q, want the handle", got)
	}
	if got := bs.Config.FormatDisplayname("Ada", "ada.bsky.social", "did:plc:x"); got != "Ada" {
		t.Errorf("contact name %q", got)
	}
	// packages/core offers the password flow by this ID.
	if !hasLoginFlow(conn, "password") {
		t.Fatalf("no password flow in %+v", conn.GetLoginFlows())
	}

	h := startSocialHost(t, "bluesky", conn)
	step := socialFirstStep(t, h, "bluesky", "password")
	if step.Type != protocol.StepUserInput {
		t.Fatalf("first step: %+v", step)
	}
	types := map[string]string{}
	for _, f := range step.Fields {
		types[f.ID] = f.Type
	}
	// The app masks a password field; the app password must arrive as one.
	if types["domain"] == "" || types["username"] == "" || types["password"] != "password" {
		t.Errorf("login fields %v", types)
	}
}

func TestBlueskyServer(t *testing.T) {
	for in, want := range map[string]string{
		"":                     "bsky.social",
		"  ":                   "bsky.social",
		"bsky.social":          "bsky.social",
		"https://bsky.social/": "bsky.social",
		"http://pds.example":   "pds.example",
		" pds.example.com ":    "pds.example.com",
	} {
		if got := blueskyServer(in); got != want {
			t.Errorf("blueskyServer(%q) = %q, want %q", in, got, want)
		}
	}
}

// A send whose answer is lost is never sent again; reads still get the connector's retries.
func TestBlueskySendsAreNotRetried(t *testing.T) {
	var posts, gets atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			posts.Add(1)
			w.WriteHeader(http.StatusBadGateway)
		case http.MethodGet:
			// The first read fails, the retry succeeds.
			if gets.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	network, _ := Lookup("bluesky")
	conn, err := network.New()
	if err != nil {
		t.Fatal(err)
	}
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{Metadata: &bluesky.UserLoginMetadata{Host: srv.URL}}}
	if err = conn.LoadUserLogin(context.Background(), login); err != nil {
		t.Fatal(err)
	}
	client := login.Client.(*bluesky.BlueskyClient)
	if _, ok := client.ChatRPC.Client.Transport.(readOnlyRetries); !ok {
		t.Fatalf("the chat client's transport is %T", client.ChatRPC.Client.Transport)
	}

	resp, err := client.ChatRPC.Client.Post(srv.URL+"/xrpc/chat.bsky.convo.sendMessage", "application/json", strings.NewReader(`{"convoId":"c","message":{"text":"hi"}}`))
	if err == nil {
		_ = resp.Body.Close()
	}
	if n := posts.Load(); n != 1 {
		t.Errorf("a send answered with 502 was made %d times, want once", n)
	}

	resp, err = client.ChatRPC.Client.Get(srv.URL + "/xrpc/chat.bsky.convo.getLog")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || gets.Load() != 2 {
		t.Errorf("a read answered with 503 then 200: status %d after %d requests, want 200 after 2", resp.StatusCode, gets.Load())
	}
}

// The HTTP client follows a 307 or 308 by posting the body again. A send answered with a
// redirect is posted once and fails as uncertain; a read still follows its redirect.
func TestBlueskySendsAreNotRedirected(t *testing.T) {
	var mu sync.Mutex
	posts := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			mu.Lock()
			posts[r.URL.Path]++
			mu.Unlock()
			if r.URL.Path == "/xrpc/chat.bsky.convo.sendMessage" {
				http.Redirect(w, r, "/xrpc/elsewhere", http.StatusTemporaryRedirect)
				return
			}
			_, _ = w.Write([]byte(`{"id":"m","rev":"r","sentAt":"2026-01-01T00:00:00Z","sender":{"did":"did:plc:x"},"text":"hi"}`))
		case r.URL.Path == "/xrpc/old.read":
			http.Redirect(w, r, "/xrpc/new.read", http.StatusTemporaryRedirect)
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	conn, err := registry["bluesky"].New()
	if err != nil {
		t.Fatal(err)
	}
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{Metadata: &bluesky.UserLoginMetadata{Host: srv.URL}}}
	if err = conn.LoadUserLogin(context.Background(), login); err != nil {
		t.Fatal(err)
	}
	client := login.Client.(*bluesky.BlueskyClient)

	_, err = client.HandleMatrixMessage(context.Background(), &bridgev2.MatrixMessage{
		MatrixEventBase: bridgev2.MatrixEventBase[*event.MessageEventContent]{
			Content: &event.MessageEventContent{MsgType: event.MsgText, Body: "hi"},
			Portal:  &bridgev2.Portal{Portal: &database.Portal{PortalKey: networkid.PortalKey{ID: "c"}}},
		},
	})
	if !errors.Is(err, errSendRedirected) {
		t.Fatalf("got %v, want the redirect refused", err)
	}
	// bridgev2 turns the connector's error into the send's status this way.
	if status := bridgev2.WrapErrorInStatus(err); status.IsCertain {
		t.Error("a redirected send was reported as certainly not sent")
	}
	mu.Lock()
	if len(posts) != 1 || posts["/xrpc/chat.bsky.convo.sendMessage"] != 1 {
		t.Errorf("posts by path: %v, want one to the send endpoint", posts)
	}
	mu.Unlock()

	resp, err := client.XRPC.Client.Get(srv.URL + "/xrpc/old.read")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Request.URL.Path != "/xrpc/new.read" {
		t.Errorf("a redirected read: status %d at %s, want 200 at /xrpc/new.read", resp.StatusCode, resp.Request.URL.Path)
	}
}

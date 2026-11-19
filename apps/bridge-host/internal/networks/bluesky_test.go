package networks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	bluesky "go.mau.fi/mautrix-bluesky/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"

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

package networks

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/util/exhttp"

	igconnector "go.mau.fi/mautrix-meta/pkg/igconnector"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/graphql"
	"go.mau.fi/mautrix-meta/pkg/messagix/httpclient"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

func TestInstagramConnectorDefaults(t *testing.T) {
	t.Setenv("INSTAGRAM_PROXY", "socks5://127.0.0.1:1080")
	conn, err := registry["instagram"].New()
	if err != nil {
		t.Fatal(err)
	}
	ig := conn.(*igconnector.IGConnector)
	if ig.Config.Proxy != "socks5://127.0.0.1:1080" {
		t.Errorf("proxy: got %q", ig.Config.Proxy)
	}
	if got := ig.Config.FormatDisplayname(igconnector.DisplaynameParams{Username: "someone"}); got != "someone" {
		t.Errorf("display name template from the defaults: got %q", got)
	}
	var flows []string
	for _, flow := range ig.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	// packages/core's NETWORK_INFO offers only the cookie flow.
	if want := []string{"android", "instagram", "instagram-password"}; !slices.Equal(flows, want) {
		t.Errorf("login flows: got %v, want %v", flows, want)
	}
	t.Setenv("INSTAGRAM_PROXY", "not a url")
	if _, err = registry["instagram"].New(); err == nil {
		t.Error("a proxy that isn't a URL was accepted")
	}
}

// Sending, editing and deleting a message or a reaction on Instagram are made once: messagix
// would otherwise post one again after an ambiguous failure. An upgrade that renames one of
// them fails here rather than leaving it repeated.
func TestInstagramWritesGoOnce(t *testing.T) {
	if _, err := registry["instagram"].New(); err != nil {
		t.Fatal(err)
	}
	for _, name := range instagramWrites {
		doc, ok := graphql.GraphQLDocs[name]
		if !ok || !doc.NoRetry {
			t.Errorf("%s: present %v, NoRetry %v", name, ok, doc.NoRetry)
		}
	}
	// Reading Instagram keeps messagix's retries.
	if graphql.GraphQLDocs["IGDMessageListOffMsysQuery"].NoRetry {
		t.Error("a query was made to go once")
	}
}

// instagramTestClient is the little of a messagix client its HTTP client asks about.
type instagramTestClient struct{ jar *cookies.Cookies }

func (c instagramTestClient) GetPlatform() types.Platform  { return types.Instagram }
func (c instagramTestClient) GetLogger() *zerolog.Logger   { log := zerolog.Nop(); return &log }
func (c instagramTestClient) GetCookies() *cookies.Cookies { return c.jar }
func (c instagramTestClient) GetEndpoint(name string) string {
	return "https://www.instagram.com/" + name
}
func (c instagramTestClient) IsAuthenticated() bool { return true }

// An edit or a deletion whose outcome is ambiguous (a 502, or a connection that broke) reaches
// Instagram once: messagix's own retries are off for it.
func TestInstagramEditAndUnsendAreNotRepeated(t *testing.T) {
	if err := instagramWritesOnce(); err != nil {
		t.Fatal(err)
	}
	failures := map[string]func(*http.Request) (*http.Response, error){
		"bad gateway": status(http.StatusBadGateway),
		"transport error": func(*http.Request) (*http.Response, error) {
			return nil, errors.New("connection reset")
		},
	}
	for _, mutation := range []string{"IGDirectEditMessageMutation", "IGDMessageUnsendDialogOffMsysMutation"} {
		for name, fail := range failures {
			t.Run(mutation+" "+name, func(t *testing.T) {
				parent := instagramTestClient{jar: &cookies.Cookies{Platform: types.Instagram}}
				cli := httpclient.NewHTTPClient(parent, httpclient.NewConfigs(parent), exhttp.ClientSettings{})
				instagram := &countingTransport{fail: fail}
				cli.HTTP = &http.Client{Transport: instagram}
				if _, _, err := cli.MakeGraphQLRequest(context.Background(), mutation, map[string]any{}); err == nil {
					t.Fatal("an ambiguous request was reported as done")
				}
				if n := instagram.calls.Load(); n != 1 {
					t.Fatalf("it reached Instagram %d times, want once", n)
				}
			})
		}
	}
}

// The cookie flow starts through the bridge host and asks for Instagram's three session
// cookies, with the routing cookies optional; missing required ones end the login without
// reaching Instagram.
func TestInstagramCookieLoginStarts(t *testing.T) {
	m := startMetaHost(t, "instagram")
	step := m.startLogin("alice", "session-cookies", "instagram")
	if step.Type != protocol.StepCookies || step.Cookies == nil {
		t.Fatalf("first step is %s, not cookies", step.Type)
	}
	if step.Cookies.URL != "https://www.instagram.com/accounts/login/" {
		t.Errorf("URL %q", step.Cookies.URL)
	}
	required, optional := cookieFields(step)
	if want := []string{"sessionid", "csrftoken", "ds_user_id"}; !slices.Equal(required, want) {
		t.Errorf("required cookies %v, want %v", required, want)
	}
	if want := []string{"rur", "shbid", "shbts", "mid", "ig_did"}; !slices.Equal(optional, want) {
		t.Errorf("optional cookies %v, want %v", optional, want)
	}
	end := m.submit("alice", "session-cookies", step, map[string]string{"sessionid": "", "csrftoken": "x", "shbid": ""})
	if end.Type != protocol.StepError || end.Error != protocol.ErrLoginFailed {
		t.Errorf("missing cookies ended with %s %s", end.Type, end.Error)
	}
}

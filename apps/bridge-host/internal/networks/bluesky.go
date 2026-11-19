package networks

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	bluesky "go.mau.fi/mautrix-bluesky/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

// blueskyDisplayname drops the connector's " (Bluesky)" suffix: the app shows each contact
// with its network's badge.
const blueskyDisplayname = "{{ or .DisplayName .Handle }}"

// blueskyDefaultServer is where an account lives unless it is on its own PDS.
const blueskyDefaultServer = "bsky.social"

func init() {
	register("bluesky", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &bluesky.BlueskyConnector{}
			if _, err := withDefaults("Bluesky", conn); err != nil {
				return nil, err
			}
			conn.Config.DisplaynameTemplate = blueskyDisplayname
			if err := conn.Config.PostProcess(); err != nil {
				return nil, fmt.Errorf("failed to set the Bluesky displayname template: %w", err)
			}
			return &blueskyConnector{conn}, nil
		},
	})
}

// blueskyConnector is the Bluesky connector with two changes for the bridge host: sends are
// never retried, and the login form takes a server as people write it.
type blueskyConnector struct {
	*bluesky.BlueskyConnector
}

// LoadUserLogin makes the login's HTTP client retry only reads. The connector's client
// (indigo's RobustHTTPClient) retries every request after a connection error or a 5xx, body
// and all, so a sent message whose answer was lost would be sent again; the bridge host
// never retries a send after an ambiguous outcome (it is recorded as unknown instead).
func (b *blueskyConnector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	if err := b.BlueskyConnector.LoadUserLogin(ctx, login); err != nil {
		return err
	}
	client, ok := login.Client.(*bluesky.BlueskyClient)
	if !ok || client.XRPC == nil || client.XRPC.Client == nil {
		return errors.New("bluesky: unexpected client")
	}
	// The connector makes this http.Client for the login and shares it between its XRPC and
	// chat clients, so one change covers both.
	httpClient := client.XRPC.Client
	httpClient.Transport = readOnlyRetries{retrying: httpClient.Transport, once: newPlainTransport()}
	return nil
}

func (b *blueskyConnector) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	process, err := b.BlueskyConnector.CreateLogin(ctx, user, flowID)
	if err != nil {
		return nil, err
	}
	inner, ok := process.(*bluesky.PasswordLogin)
	if !ok {
		return process, nil
	}
	return &blueskyLogin{inner}, nil
}

// blueskyLogin tidies the login form's input before the connector uses it: the connector
// puts the server field straight after "https://", so "https://bsky.social" or a blank
// server would fail to connect.
type blueskyLogin struct {
	*bluesky.PasswordLogin
}

func (l *blueskyLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	input["domain"] = blueskyServer(input["domain"])
	input["username"] = strings.TrimPrefix(strings.TrimSpace(input["username"]), "@")
	return l.PasswordLogin.SubmitUserInput(ctx, input)
}

// blueskyServer is the host part of what someone typed as their Bluesky server.
func blueskyServer(server string) string {
	server = strings.TrimSpace(server)
	server = strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
	server = strings.TrimRight(server, "/")
	if server == "" {
		return blueskyDefaultServer
	}
	return server
}

// readOnlyRetries sends GET and HEAD requests through the retrying transport and everything
// else (sends, read markers, session refreshes) once.
type readOnlyRetries struct {
	retrying http.RoundTripper
	once     http.RoundTripper
}

func (t readOnlyRetries) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method == http.MethodGet || req.Method == http.MethodHead {
		return t.retrying.RoundTrip(req)
	}
	return t.once.RoundTrip(req)
}

func newPlainTransport() http.RoundTripper {
	if transport, ok := http.DefaultTransport.(*http.Transport); ok {
		return transport.Clone()
	}
	return http.DefaultTransport
}

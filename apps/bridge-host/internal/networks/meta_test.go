package networks

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rs/zerolog"
	meta "go.mau.fi/mautrix-meta/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// metaHost is a started bridge host running one of the Meta networks on SQLite, with dev
// identity keys and no gateway: nothing here talks to Meta.
type metaHost struct {
	t         *testing.T
	host      *host.Host
	conn      bridgev2.NetworkConnector
	network   string
	bridgeKey seal.KeyPair
}

func startMetaHost(t *testing.T, network string) *metaHost {
	t.Helper()
	spec, ok := Lookup(network)
	if !ok {
		t.Fatalf("%s isn't registered", network)
	}
	conn, err := spec.New()
	if err != nil {
		t.Fatal(err)
	}
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	h, err := host.New(host.Config{
		Network:          network,
		DataDir:          dir,
		BridgeKey:        bridgeKey,
		NetworkConnector: conn,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		AdjustBridgeConfig: func(cfg *bridgeconfig.BridgeConfig) {
			cfg.Backfill.Queue.Enabled = false
		},
		Log: zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Starting runs the connector's own database upgrades (whatsmeow's and mautrix-meta's).
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return &metaHost{t: t, host: h, conn: conn, network: network, bridgeKey: bridgeKey}
}

// startLogin starts a login the way the gateway does and returns its first step.
func (m *metaHost) startLogin(userID, session, flowID string) *protocol.LoginStep {
	m.t.Helper()
	from := m.lastSeq()
	err := m.host.Connector.HandleCommand(context.Background(), &protocol.Command{
		CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: userID,
		LoginSessionID: session, Network: m.network, FlowID: flowID,
	})
	if err != nil {
		m.t.Fatalf("loginStart %s: %v", flowID, err)
	}
	return m.nextStep(session, from)
}

// submit sends a step's input, sealed to the bridge key as a client would, and returns the
// step that follows.
func (m *metaHost) submit(userID, session string, step *protocol.LoginStep, input map[string]string) *protocol.LoginStep {
	m.t.Helper()
	from := m.lastSeq()
	sealed, err := seal.SealJSON(protocol.LoginSubmitPlaintext{Input: input}, []seal.PublicKey{m.bridgeKey.Public},
		seal.Context{Kind: seal.KindOutbound, OwnerUserID: userID, ObjectID: session + "/" + step.StepID})
	if err != nil {
		m.t.Fatal(err)
	}
	err = m.host.Connector.HandleCommand(context.Background(), &protocol.Command{
		CommandID: session + "-" + step.StepID, Type: protocol.CommandLoginSubmit, UserID: userID,
		LoginSessionID: session, StepID: step.StepID, Sealed: sealed,
	})
	if err != nil {
		m.t.Fatalf("loginSubmit: %v", err)
	}
	return m.nextStep(session, from)
}

func (m *metaHost) lastSeq() int64 {
	m.t.Helper()
	seq, err := m.host.Store.LastSeq(context.Background())
	if err != nil {
		m.t.Fatal(err)
	}
	return seq
}

func (m *metaHost) nextStep(session string, from int64) *protocol.LoginStep {
	m.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		events, err := m.host.Store.After(context.Background(), from, 100)
		if err != nil {
			m.t.Fatal(err)
		}
		for _, evt := range events {
			from = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return evt.Step
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	m.t.Fatalf("no login step for %s", session)
	return nil
}

func cookieFields(step *protocol.LoginStep) (required, optional []string) {
	for _, f := range step.Cookies.Fields {
		if f.Required {
			required = append(required, f.ID)
		} else {
			optional = append(optional, f.ID)
		}
	}
	return required, optional
}

func TestMessengerConnectorDefaults(t *testing.T) {
	t.Setenv("META_PROXY", "")
	conn, err := registry["meta"].New()
	if err != nil {
		t.Fatal(err)
	}
	m := conn.(*meta.MetaConnector)
	cfg := m.Config
	if cfg.Proxy != "" || cfg.Tor || cfg.E2EEBackfill || cfg.CacheConnectionState {
		t.Errorf("unexpected settings: proxy %q, tor %v, e2ee backfill %v, cached state %v", cfg.Proxy, cfg.Tor, cfg.E2EEBackfill, cfg.CacheConnectionState)
	}
	if got := cfg.FormatDisplayname(meta.DisplaynameParams{Username: "someone"}); got != "someone" {
		t.Errorf("display name template from the defaults: got %q", got)
	}
	var flows []string
	for _, flow := range m.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	// packages/core's NETWORK_INFO offers the first two.
	if want := []string{"facebook", "messenger", "messenger-lite", "messenger-lite-android"}; !slices.Equal(flows, want) {
		t.Errorf("login flows: got %v, want %v", flows, want)
	}
}

func TestMetaProxyFromEnvironment(t *testing.T) {
	for _, tc := range []struct {
		value, want string
		ok          bool
	}{
		{"", "", true},
		{"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080", true},
		{"http://user:pass@proxy.example:3128", "http://user:pass@proxy.example:3128", true},
		{"proxy.example:3128", "", false},
		{"ftp://proxy.example", "", false},
	} {
		t.Run(fmt.Sprintf("%q", tc.value), func(t *testing.T) {
			t.Setenv("META_PROXY", tc.value)
			conn, err := registry["meta"].New()
			if !tc.ok {
				if err == nil {
					t.Fatal("accepted")
				}
				return
			} else if err != nil {
				t.Fatal(err)
			}
			if got := conn.(*meta.MetaConnector).Config.Proxy; got != tc.want {
				t.Errorf("proxy: got %q, want %q", got, tc.want)
			}
		})
	}
}

// Both cookie flows start through the bridge host and ask for the cookies mautrix-meta
// needs; cookies missing on submit end the login without reaching Meta.
func TestMessengerCookieLoginStarts(t *testing.T) {
	m := startMetaHost(t, "meta")
	stop := registry["meta"].Background(context.Background(), m.conn, zerolog.Nop())
	defer stop()

	for flow, url := range map[string]string{
		"facebook":  "https://www.facebook.com/",
		"messenger": "https://www.messenger.com/?no_redirect=true",
	} {
		session := "session-" + flow
		step := m.startLogin("alice", session, flow)
		if step.Type != protocol.StepCookies || step.Cookies == nil {
			t.Fatalf("%s: first step is %s, not cookies", flow, step.Type)
		}
		if step.Cookies.URL != url {
			t.Errorf("%s: URL %q, want %q", flow, step.Cookies.URL, url)
		}
		required, optional := cookieFields(step)
		if want := []string{"xs", "c_user", "datr"}; !slices.Equal(required, want) || len(optional) != 0 {
			t.Errorf("%s: cookies %v (optional %v), want %v", flow, required, optional, want)
		}
		end := m.submit("alice", session, step, map[string]string{"xs": "", "c_user": "1"})
		if end.Type != protocol.StepError || end.Error != protocol.ErrLoginFailed {
			t.Errorf("%s: missing cookies ended with %s %s", flow, end.Type, end.Error)
		}
	}
}

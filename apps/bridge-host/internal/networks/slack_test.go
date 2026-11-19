package networks

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rs/zerolog"
	slackgo "github.com/slack-go/slack"
	slack "go.mau.fi/mautrix-slack/pkg/connector"
	"go.mau.fi/mautrix-slack/pkg/connector/slackdb"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// The Slack connector is made from its documented defaults, with what the bridge host
// changes, and offers the login flows packages/core's NETWORK_INFO names.
func TestSlackConnector(t *testing.T) {
	conn, err := registry["slack"].New()
	if err != nil {
		t.Fatal(err)
	}
	sc := conn.(*slack.SlackConnector)
	if sc.Config.CustomEmojiReactions {
		t.Error("custom emoji reactions are keyed by an upload that doesn't last; they should be shortcodes")
	}
	if sc.Config.Backfill.ConversationCount != -1 || sc.Config.ParticipantSyncCount != 5 || sc.Config.DMOnly {
		t.Errorf("defaults not loaded: %+v", sc.Config)
	}
	// The templates are parsed as the defaults load; a name comes out of them.
	if name := sc.Config.FormatTeamName(&slackgo.TeamInfo{Name: "Example"}); name != "Example" {
		t.Errorf("team name: got %q", name)
	}
	if slackdb.PostgresArrayWrapper == nil {
		t.Error("the Postgres array wrapper isn't set, so pruning emoji on Postgres would panic")
	}
	var flows []string
	for _, flow := range sc.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	// Keep packages/core/src/client.ts NETWORK_INFO.slack.flows in step with these.
	if want := []string{"email", "token", "app"}; !slices.Equal(flows, want) {
		t.Errorf("login flows: got %v, want %v", flows, want)
	}
}

// Each Slack login flow starts through the bridge host and reaches its first step, none of
// which needs Slack's servers: the token flow asks for the token and cookie, the email
// flow for an address, the app flow for the two app tokens.
func TestSlackLoginStarts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h, _ := startSlackHost(ctx, t, "", "")

	firstStep := func(flow string) *protocol.LoginStep {
		t.Helper()
		from, err := h.Store.LastSeq(ctx)
		if err != nil {
			t.Fatal(err)
		}
		session := "slack-" + flow
		if err = h.Connector.HandleCommand(ctx, &protocol.Command{
			CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: "test",
			LoginSessionID: session, Network: "slack", FlowID: flow,
		}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_ = h.Connector.HandleCommand(ctx, &protocol.Command{
				CommandID: session + "-cancel", Type: protocol.CommandLoginCancel, UserID: "test", LoginSessionID: session,
			})
		}()
		for ctx.Err() == nil {
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
		t.Fatalf("%s: no login step", flow)
		return nil
	}
	fieldIDs := func(step *protocol.LoginStep) (ids []string) {
		for _, f := range step.Fields {
			ids = append(ids, f.ID+":"+f.Type)
		}
		if step.Cookies != nil {
			for _, f := range step.Cookies.Fields {
				ids = append(ids, f.ID)
			}
		}
		return ids
	}

	cases := []struct {
		flow, stepType string
		fields         []string
	}{
		{"token", protocol.StepCookies, []string{"auth_token", "cookie_token"}},
		{"email", protocol.StepUserInput, []string{"email:" + string(bridgev2.LoginInputFieldTypeEmail)}},
		{"app", protocol.StepUserInput, []string{"bot_token:token", "app_token:token"}},
	}
	for _, c := range cases {
		step := firstStep(c.flow)
		if step.Type != c.stepType || !slices.Equal(fieldIDs(step), c.fields) {
			t.Errorf("%s: got a %s step with %v, want %s with %v", c.flow, step.Type, fieldIDs(step), c.stepType, c.fields)
		}
		if c.flow == "token" && (step.Cookies == nil || step.Cookies.URL != "https://slack.com/signin") {
			t.Errorf("token: cookies %+v", step.Cookies)
		}
	}
}

// On PostgreSQL the connector prunes a workspace's deleted custom emoji with an array
// parameter, through the wrapper slack.go sets. Set TRIODITIS_TEST_POSTGRES_URI to a
// scratch database to run it.
func TestSlackEmojiPrunePostgres(t *testing.T) {
	uri := os.Getenv("TRIODITIS_TEST_POSTGRES_URI")
	if uri == "" {
		t.Skip("set TRIODITIS_TEST_POSTGRES_URI to run against PostgreSQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, sc := startSlackHost(ctx, t, "postgres", uri)
	team := fmt.Sprintf("T%d", time.Now().UnixNano())
	for _, name := range []string{"kept", "deleted"} {
		if err := sc.DB.Emoji.Put(ctx, &slackdb.Emoji{TeamID: team, EmojiID: name, Value: "https://example.com/" + name + ".png"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := sc.DB.Emoji.Prune(ctx, team, "kept"); err != nil {
		t.Fatal(err)
	}
	if count, err := sc.DB.Emoji.GetEmojiCount(ctx, team); err != nil || count != 1 {
		t.Fatalf("after pruning: %d emoji (%v), want 1", count, err)
	}
	_ = sc.DB.Emoji.Prune(ctx, team)
}

// startSlackHost runs a bridge host for Slack with dev identity keys, on SQLite in a
// temporary directory unless a database is given.
func startSlackHost(ctx context.Context, t *testing.T, dbType, dbURI string) (*host.Host, *slack.SlackConnector) {
	t.Helper()
	conn, err := registry["slack"].New()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h, err := host.New(host.Config{
		Network:          "slack",
		DataDir:          dir,
		DatabaseType:     dbType,
		DatabaseURI:      dbURI,
		BridgeKey:        bridgeKey,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		NetworkConnector: conn,
		Log:              zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return h, conn.(*slack.SlackConnector)
}

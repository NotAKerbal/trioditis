package networks

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	gmlib "github.com/beeper/groupme-lib"
	groupme "github.com/beeper/groupme/pkg/connector"
	"github.com/beeper/groupme/pkg/groupmeext"
	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

func TestGroupMeConnectorDefaults(t *testing.T) {
	conn, err := registry["groupme"].New()
	if err != nil {
		t.Fatal(err)
	}
	gm, ok := conn.(*groupmeConnector)
	if !ok {
		t.Fatalf("got %T", conn)
	}
	// The example config's one setting: active polls are refreshed while logged in.
	if gm.Config.DisablePollPolling {
		t.Error("poll polling should be on by default")
	}
	if name := conn.GetName(); name.NetworkID != "groupme" {
		t.Errorf("network ID %q", name.NetworkID)
	}
	// The wrapper must keep the optional interfaces the connector implements.
	if _, ok := conn.(bridgev2.DirectMediableNetwork); !ok {
		t.Error("the wrapper lost DirectMediableNetwork")
	}
	var ids []string
	for _, flow := range conn.GetLoginFlows() {
		ids = append(ids, flow.ID)
	}
	// packages/core's NETWORK_INFO offers access-token and password; the cookie flow is
	// left out of the client (docs/networks/groupme.md).
	if want := []string{"web", "password", "access-token"}; !slices.Equal(ids, want) {
		t.Errorf("login flows %v, want %v", ids, want)
	}
}

type groupmeHarness struct {
	t   *testing.T
	h   *host.Host
	key seal.KeyPair
}

func startGroupMeHost(t *testing.T, dbType, dbURI string) *groupmeHarness {
	t.Helper()
	conn, err := registry["groupme"].New()
	if err != nil {
		t.Fatal(err)
	}
	key, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	h, err := host.New(host.Config{
		Network: "groupme", DataDir: dir, DatabaseType: dbType, DatabaseURI: dbURI,
		BridgeKey: key, NetworkConnector: conn,
		KeyFetcher: &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		Log:        zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return &groupmeHarness{t: t, h: h, key: key}
}

// nextStep waits for the login session's next step in the journal, after seq.
func (g *groupmeHarness) nextStep(session string, seq *int64) *protocol.LoginStep {
	g.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		events, err := g.h.Store.After(context.Background(), *seq, 100)
		if err != nil {
			g.t.Fatal(err)
		}
		for _, evt := range events {
			*seq = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return evt.Step
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	g.t.Fatalf("no login step for %s", session)
	return nil
}

func (g *groupmeHarness) startLogin(flow string) (string, *protocol.LoginStep, int64) {
	g.t.Helper()
	ctx := context.Background()
	seq, err := g.h.Store.LastSeq(ctx)
	if err != nil {
		g.t.Fatal(err)
	}
	session := "groupme-" + flow
	if err = g.h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: "isaac",
		LoginSessionID: session, Network: "groupme", FlowID: flow,
	}); err != nil {
		g.t.Fatal(err)
	}
	return session, g.nextStep(session, &seq), seq
}

// Every flow's first step comes through the bridge host without reaching GroupMe, in a
// shape the desktop stepper can show.
func TestGroupMeLoginFirstSteps(t *testing.T) {
	g := startGroupMeHost(t, "", "")
	fieldTypes := func(step *protocol.LoginStep) map[string]string {
		types := make(map[string]string)
		for _, f := range step.Fields {
			types[f.ID] = f.Type
		}
		return types
	}

	_, step, _ := g.startLogin("access-token")
	if step.Type != protocol.StepUserInput || fieldTypes(step)["token"] != "token" || len(step.Fields) != 1 {
		t.Errorf("access-token: got %+v", step)
	}
	_, step, _ = g.startLogin("password")
	if types := fieldTypes(step); step.Type != protocol.StepUserInput || types["username"] != "username" || types["password"] != "password" || len(types) != 2 {
		t.Errorf("password: got %+v", step)
	}
	_, step, _ = g.startLogin("web")
	if step.Type != protocol.StepCookies || step.Cookies == nil || step.Cookies.URL != "https://web.groupme.com/" ||
		len(step.Cookies.Fields) != 1 || step.Cookies.Fields[0].ID != "token" {
		t.Errorf("web: got %+v", step)
	}
}

// A token GroupMe refuses ends the login with an error, after a sealed submit through the
// bridge host. It asks GroupMe, so it is skipped under -short and when offline.
func TestGroupMeRejectsABadToken(t *testing.T) {
	if testing.Short() {
		t.Skip("reaches api.groupme.com")
	}
	if _, err := net.LookupHost("api.groupme.com"); err != nil {
		t.Skip("offline: ", err)
	}
	g := startGroupMeHost(t, "", "")
	session, step, seq := g.startLogin("access-token")
	sealed, err := seal.SealJSON(protocol.LoginSubmitPlaintext{Input: map[string]string{"token": "not-a-groupme-token"}},
		[]seal.PublicKey{g.key.Public},
		seal.Context{Kind: seal.KindOutbound, OwnerUserID: "isaac", ObjectID: session + "/" + step.StepID})
	if err != nil {
		t.Fatal(err)
	}
	if err = g.h.Connector.HandleCommand(context.Background(), &protocol.Command{
		CommandID: session + "-submit", Type: protocol.CommandLoginSubmit, UserID: "isaac",
		LoginSessionID: session, StepID: step.StepID, Sealed: sealed,
	}); err != nil {
		t.Fatal(err)
	}
	if next := g.nextStep(session, &seq); next.Type != protocol.StepError || next.Error != protocol.ErrLoginFailed {
		t.Fatalf("got %+v", next)
	}
}

// The sweep removes the copy of a message's content once it is past GroupMe's edit window,
// keeps it for a message still within it, and leaves the rest of the metadata alone. Set
// TRIODITIS_TEST_POSTGRES_URI to a scratch database to run it against PostgreSQL too.
func TestGroupMeContentSweep(t *testing.T) {
	t.Run("sqlite", func(t *testing.T) { testGroupMeContentSweep(t, "", "") })
	t.Run("postgres", func(t *testing.T) {
		uri := os.Getenv("TRIODITIS_TEST_POSTGRES_URI")
		if uri == "" {
			t.Skip("set TRIODITIS_TEST_POSTGRES_URI to run against PostgreSQL")
		}
		testGroupMeContentSweep(t, "postgres", uri)
	})
}

func testGroupMeContentSweep(t *testing.T, dbType, dbURI string) {
	g := startGroupMeHost(t, dbType, dbURI)
	ctx := context.Background()
	br := g.h.Bridge
	// Unique per run, for a reused PostgreSQL database.
	receiver := networkid.UserLoginID(fmt.Sprintf("sweep-%d", time.Now().UnixNano()))
	portal, err := br.GetPortalByKey(ctx, networkid.PortalKey{ID: groupme.MakeGroupPortalID("1"), Receiver: receiver})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := br.GetGhostByID(ctx, groupme.MakeUserID("2"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	content := &groupmeext.MessageContent{Text: "plaintext that must not stay"}
	insert := func(msgID string, ts time.Time) {
		t.Helper()
		err := br.DB.Message.Insert(ctx, &database.Message{
			ID: networkid.MessageID(msgID), MXID: id.EventID("$" + msgID + string(receiver)), Room: portal.PortalKey,
			SenderID: sender.ID, Timestamp: ts,
			Metadata: &groupme.MessageMetadata{NativeContent: content, EditRevisionID: gmlib.ID("rev-" + msgID), EditedAt: 1},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	insert("old", now.Add(-time.Hour))
	insert("recent", now.Add(-time.Minute))

	n, err := sweepGroupMeContent(ctx, br, now.Add(-groupmeContentKeptFor))
	if err != nil {
		t.Fatal(err)
	} else if n != 1 {
		t.Fatalf("swept %d messages, want 1", n)
	}
	meta := func(id string) *groupme.MessageMetadata {
		t.Helper()
		msg, err := br.DB.Message.GetPartByID(ctx, receiver, networkid.MessageID(id), "")
		if err != nil || msg == nil {
			t.Fatalf("%s: %v", id, err)
		}
		return msg.Metadata.(*groupme.MessageMetadata)
	}
	if old := meta("old"); old.NativeContent != nil || old.EditRevisionID != "rev-old" || old.EditedAt != 1 {
		t.Errorf("old message: %+v", old)
	}
	if recent := meta("recent"); recent.NativeContent == nil || recent.NativeContent.Text != content.Text {
		t.Errorf("recent message lost its content within the edit window: %+v", recent)
	}
	// The text is gone from the stored row itself, not just from what bridgev2 reads back.
	var stored int
	if err = br.DB.QueryRow(ctx, `SELECT COUNT(*) FROM message WHERE bridge_id = $1 AND room_receiver = $2 AND CAST(metadata AS TEXT) LIKE $3`,
		br.ID, receiver, "%"+content.Text+"%").Scan(&stored); err != nil {
		t.Fatal(err)
	} else if stored != 1 {
		t.Errorf("%d rows still hold the text, want 1 (the recent message)", stored)
	}
	// Nothing left to do: a second sweep changes nothing.
	if n, err = sweepGroupMeContent(ctx, br, now.Add(-groupmeContentKeptFor)); err != nil || n != 0 {
		t.Fatalf("second sweep: %d, %v", n, err)
	}

	// The background sweep runs at once and stops when asked.
	insert("backfilled", now.Add(-48*time.Hour))
	stop := startGroupMeSweep(ctx, br, time.Hour, zerolog.Nop())
	deadline := time.Now().Add(5 * time.Second)
	for meta("backfilled").NativeContent != nil {
		if time.Now().After(deadline) {
			t.Fatal("the background sweep didn't run at start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()
}

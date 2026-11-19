package networks

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// Made-up credentials in the right shape. Nothing here reaches Telegram, which would refuse
// them.
const (
	testTelegramAPIID   = "1234567"
	testTelegramAPIHash = "0123456789abcdef0123456789abcdef"
)

func setTelegramCredentials(t *testing.T) {
	t.Setenv(telegramAPIIDEnv, testTelegramAPIID)
	t.Setenv(telegramAPIHashEnv, testTelegramAPIHash)
}

// Without an API ID and hash from the operator, or with ones that can't be right, the
// connector isn't made, and the error says what to set. With them, it is, with this
// deployment's settings.
func TestTelegramNeedsOperatorCredentials(t *testing.T) {
	for _, tc := range []struct {
		name, id, hash, want string
	}{
		{"neither", "", "", "my.telegram.org"},
		{"no hash", testTelegramAPIID, "", telegramAPIHashEnv},
		{"no ID", "", testTelegramAPIHash, telegramAPIIDEnv},
		{"ID not a number", "abc", testTelegramAPIHash, telegramAPIIDEnv},
		{"ID zero", "0", testTelegramAPIHash, telegramAPIIDEnv},
		{"example hash", testTelegramAPIID, "tjyd5yge35lbodk1xwzw2jstp90k55qz", telegramAPIHashEnv},
		{"hash cut short", testTelegramAPIID, testTelegramAPIHash[:31], telegramAPIHashEnv},
		{"values swapped", testTelegramAPIHash, testTelegramAPIID, telegramAPIIDEnv},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(telegramAPIIDEnv, tc.id)
			t.Setenv(telegramAPIHashEnv, tc.hash)
			if _, err := newTelegram(); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error mentioning %s", err, tc.want)
			}
		})
	}

	setTelegramCredentials(t)
	t.Setenv(telegramAPIHashEnv, " "+testTelegramAPIHash+"\n")
	conn, err := newTelegram()
	if err != nil {
		t.Fatal(err)
	}
	tg := conn.(*telegramConnector)
	cfg := tg.Config
	if cfg.APIID != 1234567 || cfg.APIHash != testTelegramAPIHash {
		t.Errorf("credentials: got %d %q", cfg.APIID, cfg.APIHash)
	}
	if cfg.DeviceInfo.DeviceModel != "Trioditis" || cfg.SavedMessagesAvatar != "" {
		t.Errorf("device model %q, saved messages avatar %q", cfg.DeviceInfo.DeviceModel, cfg.SavedMessagesAvatar)
	}
	// The rest still comes from the connector's own defaults.
	if cfg.AnimatedSticker.Target != "gif" || cfg.Sync.CreateLimit != 15 || cfg.Ping.IntervalSeconds != 30 {
		t.Errorf("defaults not loaded: %+v", cfg)
	}
	var flows []string
	for _, flow := range conn.GetLoginFlows() {
		flows = append(flows, flow.ID)
	}
	// The flows the client offers (packages/core NETWORK_INFO) must be the connector's.
	for _, want := range []string{"qr", "phone"} {
		if !slices.Contains(flows, want) {
			t.Errorf("login flows %v lack %q", flows, want)
		}
	}
}

func startTelegramHost(t *testing.T, dir string) *host.Host {
	t.Helper()
	setTelegramCredentials(t)
	conn, err := newTelegram()
	if err != nil {
		t.Fatal(err)
	}
	bridgeKey, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	h, err := host.New(host.Config{
		Network:          "telegram",
		DataDir:          dir,
		BridgeKey:        bridgeKey,
		KeyFetcher:       &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")},
		NetworkConnector: conn,
		Log:              zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	return h
}

// waitForLoginStep returns the next step the host reports for a login session.
func waitForLoginStep(t *testing.T, h *host.Host, session string, from *int64) *protocol.LoginStep {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		events, err := h.Store.After(context.Background(), *from, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range events {
			*from = evt.Seq
			if evt.Type == protocol.EventLoginStep && evt.LoginSessionID == session {
				return evt.Step
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no login step for %s", session)
	return nil
}

// A phone login starts through the bridge host's commands, as the gateway would send them,
// and asks for the phone number without contacting Telegram (the next step would). The step
// carries the field type the login stepper renders. Cancelling ends it.
func TestTelegramPhoneLoginStartsThroughHost(t *testing.T) {
	h := startTelegramHost(t, t.TempDir())
	t.Cleanup(h.Stop)
	ctx := context.Background()
	from, err := h.Store.LastSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const user, session = "user-1", "session-phone"
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "start", Type: protocol.CommandLoginStart, UserID: user,
		LoginSessionID: session, Network: "telegram", FlowID: "phone",
	}); err != nil {
		t.Fatal(err)
	}
	step := waitForLoginStep(t, h, session, &from)
	if step.Type != protocol.StepUserInput || len(step.Fields) != 1 {
		t.Fatalf("first step: %+v", step)
	}
	if field := step.Fields[0]; field.Type != string(bridgev2.LoginInputFieldTypePhoneNumber) || field.ID == "" {
		t.Fatalf("phone field: %+v", field)
	}
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: "cancel", Type: protocol.CommandLoginCancel, UserID: user, LoginSessionID: session,
	}); err != nil {
		t.Fatal(err)
	}
	if step = waitForLoginStep(t, h, session, &from); step.Type != protocol.StepCancelled {
		t.Fatalf("after cancel: %+v", step)
	}
}

// The connector's file cache never hands back a content URI whose upload the bridge host
// has let go: entries go at start-up and once they're older than the sweep allows.
func TestTelegramFileCacheIsForgotten(t *testing.T) {
	if telegramFileMaxAge+telegramFileSweepInterval >= media.UploadTTL {
		t.Fatalf("a cached file can outlive its upload: %v + %v >= %v", telegramFileMaxAge, telegramFileSweepInterval, media.UploadTTL)
	}
	dir := t.TempDir()
	h := startTelegramHost(t, dir)
	tg := h.Bridge.Network.(*telegramConnector)
	ctx := context.Background()
	insert := func(id string, ts any) {
		t.Helper()
		if _, err := tg.Store.Exec(ctx, "INSERT INTO telegram_file (id, mxc, timestamp) VALUES ($1, $2, $3)",
			id, "mxc://trioditis.local/"+id, ts); err != nil {
			t.Fatal(err)
		}
	}
	remaining := func() []string {
		t.Helper()
		rows, err := tg.Store.Query(ctx, "SELECT id FROM telegram_file ORDER BY id")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}
	insert("fresh", time.Now().Unix())
	insert("old", time.Now().Add(-telegramFileMaxAge-time.Minute).Unix())
	insert("untimed", nil)
	if err := sweepTelegramFiles(ctx, tg, telegramFileMaxAge); err != nil {
		t.Fatal(err)
	}
	if got := remaining(); !slices.Equal(got, []string{"fresh"}) {
		t.Fatalf("after a sweep: %v", got)
	}

	// The background sweep starts and stops cleanly.
	stop := registry["telegram"].Background(ctx, tg, zerolog.Nop())
	stop()
	h.Stop()

	// Everything the last run uploaded went with it.
	h = startTelegramHost(t, dir)
	t.Cleanup(h.Stop)
	tg = h.Bridge.Network.(*telegramConnector)
	if got := remaining(); len(got) != 0 {
		t.Fatalf("after a restart: %v", got)
	}
}

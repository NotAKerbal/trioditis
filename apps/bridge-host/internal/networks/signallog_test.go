package networks

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/protobuf/backuppb"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/protobuf/signalpb"
	"google.golang.org/protobuf/proto"
)

// The two lines signalmeow logs at info level with a secret or a contact's details, logged as
// signalmeow logs them (backup.go, receiving.go) with its own types and synthetic values,
// lose those fields and keep the rest. The protobuf types are plain Go, so this runs without
// libsignal.
func TestSignalLogFilterDropsTheBackupKeyAndContactDetails(t *testing.T) {
	key := bytes.Repeat([]byte{0xa5}, 32)
	var out bytes.Buffer
	log := zerolog.New(signalLogFilter(&out))
	log.Info().Any("backup_info", &backuppb.BackupInfo{Version: 1, BackupTimeMs: 1700000000000, MediaRootBackupKey: key}).
		Str("component", "signalmeow").Msg("Received backup info")
	log.Info().Any("contact", &signalpb.ContactDetails{Name: proto.String("Ada Lovelace"), Number: proto.String("+15550001234")}).
		Msg("Signal Contact UUID is nil, skipping")

	text := out.String()
	for _, secret := range []string{base64.StdEncoding.EncodeToString(key), "Ada Lovelace", "+15550001234"} {
		if strings.Contains(text, secret) {
			t.Errorf("the log still has %q:\n%s", secret, text)
		}
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d:\n%s", len(lines), text)
	}
	for i, want := range []struct{ message, dropped string }{
		{"Received backup info", "backup_info"},
		{"Signal Contact UUID is nil, skipping", "contact"},
	} {
		var line struct {
			Level, Message, Component string
			Dropped                   []string `json:"dropped_fields"`
		}
		if err := json.Unmarshal([]byte(lines[i]), &line); err != nil {
			t.Fatal(err)
		}
		if line.Message != want.message || line.Level != "info" || len(line.Dropped) != 1 || line.Dropped[0] != want.dropped {
			t.Errorf("line %d: got %+v, want %q with %s dropped", i, line, want.message, want.dropped)
		}
		if i == 0 && line.Component != "signalmeow" {
			t.Errorf("an ordinary field was dropped too: %s", lines[i])
		}
	}
}

// A line with nothing to drop passes through byte for byte; one that isn't JSON (a raw field
// that wasn't valid) is replaced, since nothing in it is known to be safe.
func TestSignalLogFilterPassesOrdinaryLinesAndReplacesUnreadableOnes(t *testing.T) {
	var out bytes.Buffer
	filter := signalLogFilter(&out)
	ordinary := `{"level":"info","component":"signalmeow","message":"Connected"}` + "\n"
	if _, err := filter.Write([]byte(ordinary)); err != nil {
		t.Fatal(err)
	}
	if out.String() != ordinary {
		t.Fatalf("an ordinary line changed: %q", out.String())
	}
	out.Reset()
	if _, err := filter.Write([]byte(`{"level":"debug","response_body":{"name":"Ada Lovelace"` + "\n")); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Ada") || !strings.Contains(out.String(), "wasn't valid JSON") {
		t.Fatalf("an unreadable line wasn't replaced: %q", out.String())
	}
}

// Trace-only fields with keys or credentials go too, should trace ever be turned on.
func TestSignalLogFilterDropsTraceSecrets(t *testing.T) {
	var out bytes.Buffer
	log := zerolog.New(signalLogFilter(&out)).Level(zerolog.TraceLevel)
	log.Trace().Any("account_record", map[string]string{"profileKey": "marker-profile-key"}).Msg("Found account record")
	log.Trace().Any("creds", map[string]string{"password": "marker-password"}).Msg("Got contact discovery credentials")
	if strings.Contains(out.String(), "marker-") {
		t.Fatalf("a trace secret reached the log: %q", out.String())
	}
	if !strings.Contains(out.String(), "Found account record") || !strings.Contains(out.String(), "Got contact discovery credentials") {
		t.Fatalf("the lines themselves were lost: %q", out.String())
	}
}

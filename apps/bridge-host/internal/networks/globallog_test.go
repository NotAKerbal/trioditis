package networks

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	globallog "github.com/rs/zerolog/log"
	"go.mau.fi/mautrix-meta/pkg/messagix/lightspeed"
)

// decoderTable stands in for messagix's table: one stored procedure whose rows have a single
// field and no Unrecognized map, so an extra field is logged rather than kept.
type decoderTable struct {
	LSTestRow []*decoderRow
}

type decoderRow struct {
	ThreadName string `index:"0"`
}

// The pinned lightspeed decoder logs raw protocol data through zerolog's global logger when
// it meets something it doesn't know. Fed payloads like that, carrying a marker where
// message text would be, the global logger as the bridge host sets it up must keep the
// warnings and never the marker, at whichever level the host runs.
func TestGlobalLoggerDropsDecoderData(t *testing.T) {
	const marker = "SECRET-MARKER"
	saved := globallog.Logger
	t.Cleanup(func() { globallog.Logger = saved })

	for _, level := range []zerolog.Level{zerolog.TraceLevel, zerolog.DebugLevel, zerolog.InfoLevel} {
		t.Run(level.String(), func(t *testing.T) {
			var out bytes.Buffer
			// As cmd/bridge-host does it, console output included.
			globallog.Logger = GlobalLogger(zerolog.ConsoleWriter{Out: &out, NoColor: true}, level)
			if got := globallog.Logger.GetLevel(); got < zerolog.WarnLevel {
				t.Fatalf("global logger level %s: the decoder logs its data below warn", got)
			}
			decoder := lightspeed.NewLightSpeedDecoder(lightspeed.DependencyMap{"testProcedure": "LSTestRow"}, &decoderTable{})
			for _, payload := range [][]any{
				// An opcode the decoder doesn't know.
				{float64(999), marker + " hello", []any{marker}},
				// A field a known stored procedure doesn't have.
				{float64(lightspeed.CALL_STORED_PROCEDURE), "testProcedure", "a name", marker + " text"},
				// A stored procedure the decoder doesn't know.
				{float64(lightspeed.CALL_STORED_PROCEDURE), "newProcedure", marker},
				// Malformed data in known opcodes: the error itself quotes the input.
				{float64(lightspeed.I64_FROM_STRING), marker},
				{float64(lightspeed.TO_BLOB), marker + "!"},
				{float64(lightspeed.STORE_ARRAY), marker},
				// The server's own log line, which the decoder puts in the message.
				{float64(lightspeed.LOGGER_LOG), marker},
			} {
				decoder.Decode(payload)
			}
			logged := out.String()
			if strings.Contains(logged, marker) {
				t.Fatalf("the marker reached the log:\n%s", logged)
			}
			// The warnings themselves are kept, with what is safe to say about them.
			for _, want := range []string{
				"Got unknown step type", "step_type=999", "dropped_fields=",
				"Found unknown non-nil field", "struct_name=decoderRow", "item_type=string",
				"Skipping dependency with no reference", "reference_name=newProcedure",
				"failed to convert string to int64", "Failed to decode blob", "Bad step data in STORE_ARRAY",
			} {
				if !strings.Contains(logged, want) {
					t.Errorf("%q isn't in the log:\n%s", want, logged)
				}
			}
		})
	}
}

func TestGlobalLogFilterDropsUnlistedFields(t *testing.T) {
	var out bytes.Buffer
	log := GlobalLogger(&out, zerolog.InfoLevel)
	log.Warn().Str("message_id", "mid.1").Str("text", "hello").Any("nested", map[string]string{"message_id": "x"}).Msg("Something new")
	log.Info().Str("message_id", "mid.2").Msg("Below warn")
	got := out.String()
	if !strings.Contains(got, `"message_id":"mid.1"`) || !strings.Contains(got, `"dropped_fields":["nested","text"]`) {
		t.Errorf("filtered line: %s", got)
	}
	if strings.Contains(got, "hello") || strings.Contains(got, `"x"`) || strings.Contains(got, "mid.2") {
		t.Errorf("unlisted data or an info line was written: %s", got)
	}
}

package networks

import (
	"encoding/json"
	"io"
	"slices"

	"github.com/rs/zerolog"
)

// GlobalLogger is what zerolog's global logger (github.com/rs/zerolog/log) should be in the
// bridge host. In this binary only mautrix-meta (Messenger and Instagram) logs through it:
// its protocol decoder (messagix/lightspeed) and table code warn about anything they don't
// recognise, such as a new opcode or field, and attach the raw protocol data to the warning
// (step_data, item, input_data, blob_base64 and others), message text and names included. At
// trace level they add more.
//
// So the global logger writes through a filter that keeps only the fields named in
// globalLogFields, which are type, field and procedure names, indexes and IDs, and lists the
// names of any others it dropped. It never logs below warn, whatever level is asked for: the
// decoder's one debug line ("Facebook server log") puts the server's data in the message
// itself, and at trace the decoder stops redacting. The messages it keeps are the decoders'
// fixed strings. Every other network logs through the host's own logger, so this changes
// nothing for them.
func GlobalLogger(w io.Writer, level zerolog.Level) zerolog.Logger {
	return zerolog.New(globalLogFilter{next: w}).Level(max(level, zerolog.WarnLevel)).
		With().Timestamp().Bool("global_log", true).Logger()
}

// globalLogFields are the fields a global log line keeps. Each one is set from the
// connector's own types or from protocol identifiers, never from message data: a field that
// isn't listed is dropped, so a field an upgrade adds is dropped until it is checked here.
var globalLogFields = map[string]bool{
	zerolog.TimestampFieldName: true,
	zerolog.LevelFieldName:     true,
	zerolog.MessageFieldName:   true,
	"global_log":               true,

	// lightspeed/decode.go: the step's opcode, the statement key, the stored procedure's
	// name and the Go struct, field, kind and types involved.
	"step_type":      true,
	"key":            true,
	"reference_name": true,
	"ls_type":        true,
	"struct_name":    true,
	"field_name":     true,
	"field_index":    true,
	"index":          true,
	"kind":           true,
	"val_type":       true,
	"item_type":      true,
	"data_length":    true,
	// table/table.go: a stored procedure's name.
	"dependency": true,
	// table/wrappedmessage.go: Meta's IDs for a thread, message or attachment.
	"thread_id":     true,
	"message_id":    true,
	"attachment_id": true,
}

// globalLogFilter rewrites each zerolog line written to it with only globalLogFields.
type globalLogFilter struct {
	next io.Writer
}

func (f globalLogFilter) Write(p []byte) (int, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(p, &fields); err != nil {
		// Not a zerolog line, so nothing in it is known to be safe to show.
		return len(p), nil
	}
	var dropped []string
	for key := range fields {
		if !globalLogFields[key] {
			dropped = append(dropped, key)
			delete(fields, key)
		}
	}
	if len(dropped) > 0 {
		slices.Sort(dropped)
		fields["dropped_fields"], _ = json.Marshal(dropped)
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return 0, err
	}
	if _, err = f.next.Write(append(out, '\n')); err != nil {
		return 0, err
	}
	return len(p), nil
}

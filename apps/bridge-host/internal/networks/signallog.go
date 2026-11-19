package networks

import (
	"encoding/json"
	"io"
	"slices"
)

// signalLogDropped are the log fields mautrix-signal's store (signalmeow) fills with a secret,
// a contact's details or message data. Signal's bridge host writes its log through
// signalLogFilter, which drops them from every line, so they never reach the output whatever
// the level. Matched by name at the top level of a line, where signalmeow puts them; the rest
// of each line is kept as it was.
var signalLogDropped = map[string]bool{
	// backup.go, info: the history transfer's BackupInfo, its mediaRootBackupKey included.
	"backup_info": true,
	// receiving.go, info: a contact-sync entry without a Signal ID, with the contact's name
	// and phone number ("Signal Contact UUID is nil, skipping").
	"contact": true,
	// Trace only, which the bridge host never asks for; dropped in case that changes. An
	// outgoing message's content (sending.go), a history frame (backup.go), the provisioning
	// message with the account's keys (provisioning.go), a storage-service contact record
	// and an undecodable storage item (storageservice.go), and profile responses (profile.go,
	// also a failed attachment download's response at debug, attachments.go).
	"raw_content":           true,
	"backup_frame":          true,
	"msg":                   true,
	"contact_record":        true,
	"item_data":             true,
	"response_data":         true,
	"invalid_response_data": true,
}

// signalLogFilter rewrites each zerolog line written to it without signalLogDropped, listing
// the names of any it dropped.
func signalLogFilter(next io.Writer) io.Writer {
	return signalLog{next: next}
}

type signalLog struct {
	next io.Writer
}

// signalLogUnreadable replaces a line that isn't JSON: zerolog writes only JSON, so such a
// line came from a raw field that wasn't valid, and nothing in it is known to be safe.
var signalLogUnreadable = []byte(`{"level":"warn","message":"Dropped a log line that wasn't valid JSON"}` + "\n")

func (l signalLog) Write(p []byte) (int, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(p, &fields); err != nil {
		if _, err = l.next.Write(signalLogUnreadable); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	var dropped []string
	for key := range fields {
		if signalLogDropped[key] {
			dropped = append(dropped, key)
			delete(fields, key)
		}
	}
	if len(dropped) == 0 {
		return l.next.Write(p)
	}
	slices.Sort(dropped)
	fields["dropped_fields"], _ = json.Marshal(dropped)
	out, err := json.Marshal(fields)
	if err != nil {
		return 0, err
	}
	if _, err = l.next.Write(append(out, '\n')); err != nil {
		return 0, err
	}
	return len(p), nil
}

package protocol

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// schemaJSON is the protocol's event schema: for each event type, the fields it must and may
// carry and the most its sealed content may hold. It is written from the backend's
// bridgeEvent validator by packages/backend/scripts/write-protocol-schema.ts, so the bridge
// host keeps no copy of its own that could drift from what the backend accepts.
//
//go:embed events.json
var schemaJSON []byte

// eventShape is what one event type carries beyond the fields every event has.
type eventShape struct {
	Required []string `json:"required"`
	Optional []string `json:"optional"`
	// MaxSealedBytes is the most the event's sealed ciphertext may hold; 0 for a type with no
	// sealed content.
	MaxSealedBytes int `json:"maxSealedBytes"`
}

type eventSchema struct {
	Version int                   `json:"version"`
	Common  []string              `json:"common"`
	Events  map[string]eventShape `json:"events"`
}

// schema is read once, at startup. The file is part of the binary and its tests, so one that
// doesn't parse is a build that was never tested, and stopping is the only safe answer.
var schema = loadSchema(schemaJSON)

func loadSchema(data []byte) eventSchema {
	var s eventSchema
	if err := json.Unmarshal(data, &s); err != nil {
		panic(fmt.Sprintf("protocol: events.json: %v", err))
	}
	if s.Version != Version {
		panic(fmt.Sprintf("protocol: events.json is for protocol version %d, not %d", s.Version, Version))
	}
	return s
}

// CheckShape reports whether one event's JSON has exactly the fields the backend accepts for
// its type: every field every event has, its type's required fields, and nothing else. The
// gateway makes the same check (with the backend's validator) before passing an event on and
// quarantines one that fails, so fakes of the gateway use this to refuse what it would.
// Only the field names are checked, not their values.
func CheckShape(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidEvent, err)
	}
	var eventType string
	_ = json.Unmarshal(fields["type"], &eventType)
	shape, ok := schema.Events[eventType]
	if !ok {
		return fmt.Errorf("%w: unknown event type %q", ErrInvalidEvent, eventType)
	}
	allowed := make(map[string]bool, len(fields))
	for _, group := range [][]string{schema.Common, shape.Required} {
		for _, name := range group {
			allowed[name] = true
			if _, ok := fields[name]; !ok {
				return fmt.Errorf("%w: %s event is missing %s", ErrInvalidEvent, eventType, name)
			}
		}
	}
	for _, name := range shape.Optional {
		allowed[name] = true
	}
	for name := range fields {
		if !allowed[name] {
			return fmt.Errorf("%w: %s event has unexpected field %s", ErrInvalidEvent, eventType, name)
		}
	}
	return nil
}

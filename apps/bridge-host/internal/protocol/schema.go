package protocol

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
)

// schemaJSON is the protocol's event schema: for each event type, the fields it must and may
// carry, the values those from a fixed set may take, and the most its sealed content may hold. It is written from the backend's
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
	// Values holds, for each field (by dotted path; "[]" steps into an array) that is one of a
	// set of values, which values it may be: a send status, an error code, a chat's kind.
	Values map[string][]any `json:"values"`
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
// Of the values, only those from a fixed set (a status, an error code) are checked.
func CheckShape(data []byte) error {
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidEvent, err)
	}
	eventType, _ := fields["type"].(string)
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
	for path, allowed := range shape.Values {
		for _, value := range valuesAt(fields, strings.Split(path, ".")) {
			// DeepEqual, as a value of the wrong kind (an object, say) can't be compared with ==.
			if !slices.ContainsFunc(allowed, func(a any) bool { return reflect.DeepEqual(a, value) }) {
				return fmt.Errorf("%w: %s event's %s is %v, not one of %v", ErrInvalidEvent, eventType, path, value, allowed)
			}
		}
	}
	return nil
}

// valuesAt is what a JSON value holds at a dotted path, where a step ending in "[]" is each
// element of an array; a path that isn't there has nothing.
func valuesAt(value any, path []string) []any {
	if len(path) == 0 {
		return []any{value}
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	step, each := strings.CutSuffix(path[0], "[]")
	next, ok := object[step]
	if !ok {
		return nil
	}
	if !each {
		return valuesAt(next, path[1:])
	}
	items, _ := next.([]any)
	var out []any
	for _, item := range items {
		out = append(out, valuesAt(item, path[1:])...)
	}
	return out
}

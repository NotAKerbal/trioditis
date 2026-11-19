// Package networks is the list of networks the bridge host can run: one file per network,
// each registering how to make its connector and any work it needs alongside the host.
// A new network is a new file here plus its entries in packages/core, compose and the
// installer; see docs/networks/README.md.
package networks

import (
	"context"
	"fmt"
	"io"
	"slices"

	"github.com/rs/zerolog"
	"gopkg.in/yaml.v3"
	"maunium.net/go/mautrix/bridgev2"
)

// Network is one network the bridge host can run.
type Network struct {
	// New makes the network's connector, configured. A network this binary was built
	// without returns an error saying how to build it in.
	New func() (bridgev2.NetworkConnector, error)
	// Background, if set, starts work the network needs while the host runs (after it has
	// started) and returns a function that stops that work and waits for it. It is called
	// before the host and its database stop.
	Background func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) (stop func())
	// ReceiveOnly makes the host refuse sends, edits, reactions and deletions, for a
	// connector that can resubmit a message after an ambiguous outcome, which the host
	// can't prevent: sends must never be retried then (AGENTS.md).
	ReceiveOnly bool
	// LogFilter, if set, wraps the process's log output, to drop what the connector logs
	// that must not be written out.
	LogFilter func(io.Writer) io.Writer
}

var registry = map[string]Network{}

func register(name string, network Network) {
	if _, ok := registry[name]; ok {
		panic(fmt.Sprintf("network %q registered twice", name))
	}
	registry[name] = network
}

// Lookup returns the network called name.
func Lookup(name string) (Network, bool) {
	network, ok := registry[name]
	return network, ok
}

// Names lists every network, sorted.
func Names() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// withDefaults loads a connector's documented defaults, as its example config gives them,
// the way the mautrix bridges do when no config file overrides them.
func withDefaults(name string, conn bridgev2.NetworkConnector) (bridgev2.NetworkConnector, error) {
	example, data, _ := conn.GetConfig()
	if data == nil {
		return conn, nil
	}
	if err := yaml.Unmarshal([]byte(example), data); err != nil {
		return nil, fmt.Errorf("failed to load %s defaults: %w", name, err)
	}
	return conn, nil
}

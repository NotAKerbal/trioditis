package networks

import (
	"context"
	"fmt"
	"time"

	groupme "github.com/beeper/groupme/pkg/connector"
	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	"maunium.net/go/mautrix/bridgev2"
)

// The GroupMe connector copies every message's text and attachments into bridgev2's message
// table (the message metadata's native_content), so it can resend them unchanged when the
// message is edited and recognize the echo of its own edit. GroupMe only allows an edit
// within 15 minutes of a message, so past that the copy is plaintext with no use. The host
// removes it from every message older than groupmeContentKeptFor, at start-up and every
// groupmeSweepInterval. See docs/networks/groupme.md, What it keeps in plaintext.
const (
	// groupmeContentKeptFor is GroupMe's 15-minute edit window with a margin, so an edit made
	// at the last moment, and its echo, still find the copy they compare against.
	groupmeContentKeptFor = 30 * time.Minute
	groupmeSweepInterval  = 5 * time.Minute
)

func init() {
	register("groupme", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &groupmeConnector{GMConnector: &groupme.GMConnector{}}
			if _, err := withDefaults("GroupMe", conn); err != nil {
				return nil, err
			}
			return conn, nil
		},
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			gm := conn.(*groupmeConnector)
			return startGroupMeSweep(ctx, gm.bridge, groupmeSweepInterval, log.With().Str("component", "groupme content sweep").Logger())
		},
	})
}

// groupmeConnector is the GroupMe connector, keeping hold of the bridge it runs in so the
// sweep can reach bridgev2's database. Every other method, and so every optional bridgev2
// interface the connector implements, is the embedded connector's own.
type groupmeConnector struct {
	*groupme.GMConnector
	bridge *bridgev2.Bridge
}

func (c *groupmeConnector) Init(br *bridgev2.Bridge) {
	c.bridge = br
	c.GMConnector.Init(br)
}

// Each statement removes the key in one step, so a message written while it runs keeps
// whatever it was written with, and the next sweep looks at it again.
const (
	sweepGroupMeContentPostgres = `
		UPDATE message SET metadata = metadata - 'native_content'
		WHERE bridge_id = $1 AND timestamp < $2 AND metadata -> 'native_content' IS NOT NULL`
	sweepGroupMeContentSQLite = `
		UPDATE message SET metadata = json_remove(metadata, '$.native_content')
		WHERE bridge_id = $1 AND timestamp < $2 AND json_type(metadata, '$.native_content') IS NOT NULL`
)

// sweepGroupMeContent removes the copy of each message's content from messages sent before
// cutoff, and returns how many it changed.
func sweepGroupMeContent(ctx context.Context, br *bridgev2.Bridge, cutoff time.Time) (int64, error) {
	query := sweepGroupMeContentSQLite
	if br.DB.Dialect == dbutil.Postgres {
		query = sweepGroupMeContentPostgres
	}
	res, err := br.DB.Exec(ctx, query, br.ID, cutoff.UnixNano())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// startGroupMeSweep sweeps now and then every interval, until ctx ends or the function it
// returns is called; that function waits for a sweep in progress, so the caller can then
// close the database. Only an error's type is logged.
func startGroupMeSweep(ctx context.Context, br *bridgev2.Bridge, interval time.Duration, log zerolog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if n, err := sweepGroupMeContent(ctx, br, time.Now().Add(-groupmeContentKeptFor)); err != nil {
				if ctx.Err() == nil {
					log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Failed to clear GroupMe message content")
				}
			} else if n > 0 {
				log.Debug().Int64("messages", n).Msg("Cleared GroupMe message content past the edit window")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

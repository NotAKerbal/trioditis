// Package gateway is the bridge host's side of the gateway protocol: it pushes the journal
// to the gateway in order, at least once, and fetches recipient keys.
package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/rs/zerolog"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/keys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// Client talks to the gateway's internal API.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{BaseURL: baseURL, Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.HTTP.Do(req)
}

// ConflictError is the gateway asking for events from an earlier sequence number.
type ConflictError struct{ ExpectedSeq int64 }

func (e *ConflictError) Error() string {
	return fmt.Sprintf("gateway expects events from seq %d", e.ExpectedSeq)
}

// PostEvents sends a batch and returns the gateway's acknowledgement.
func (c *Client) PostEvents(ctx context.Context, batch *protocol.EventBatch) (int64, error) {
	resp, err := c.do(ctx, http.MethodPost, "/v1/events", batch)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		var ack protocol.EventBatchResponse
		if err = json.NewDecoder(resp.Body).Decode(&ack); err != nil {
			return 0, fmt.Errorf("invalid ack: %w", err)
		}
		return ack.AckedThrough, nil
	case http.StatusConflict:
		var conflict protocol.EventBatchConflict
		if err = json.NewDecoder(resp.Body).Decode(&conflict); err != nil {
			return 0, fmt.Errorf("invalid conflict response: %w", err)
		}
		return 0, &ConflictError{ExpectedSeq: conflict.ExpectedSeq}
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return 0, fmt.Errorf("gateway returned %d: %s", resp.StatusCode, body)
	}
}

// FetchKeys gets a person's recipient keys. It implements keys.Fetcher.
func (c *Client) FetchKeys(ctx context.Context, userID string) (*protocol.RecipientKeys, error) {
	resp, err := c.do(ctx, http.MethodGet, "/v1/keys/"+url.PathEscape(userID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		var out protocol.RecipientKeys
		if err = json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return nil, err
		}
		return &out, nil
	case http.StatusConflict:
		return nil, keys.ErrNoIdentityKey
	default:
		return nil, fmt.Errorf("gateway returned %d for keys", resp.StatusCode)
	}
}

// Pusher delivers the journal to the gateway.
type Pusher struct {
	Client      *Client
	Store       *store.Store
	HostID      string
	Network     string
	CommandAddr string
	BatchSize   int
	Log         zerolog.Logger

	wake     chan struct{}
	pressure pressure
}

func NewPusher(client *Client, st *store.Store, hostID, network, commandAddr string, log zerolog.Logger) *Pusher {
	return &Pusher{
		Client: client, Store: st, HostID: hostID, Network: network, CommandAddr: commandAddr,
		BatchSize: 100, Log: log, wake: make(chan struct{}, 1),
	}
}

// Wake tells the pusher new events are in the journal.
func (p *Pusher) Wake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

const (
	idleWait = 5 * time.Second
	// HeartbeatInterval is how often an empty batch tells the gateway the host is alive.
	// The gateway only dispatches commands to hosts heard from in the last two minutes.
	HeartbeatInterval = 30 * time.Second
	maxBackoff        = 30 * time.Second
	// MaxBatchBytes caps a batch's JSON, as the gateway requires. A batch holds at least one
	// event, and no event is sent larger than protocol.MaxEventBytes, so even a batch of one
	// stays far inside the gateway's 32 MiB body limit.
	MaxBatchBytes = 8 * 1024 * 1024
)

// Run pushes until ctx is cancelled. Events are resent from the gateway's last
// acknowledgement until acknowledged, so delivery is at least once and in order. An empty
// batch on startup, and whenever nothing else was sent for HeartbeatInterval, registers
// the host and tells it where the gateway has got to.
func (p *Pusher) Run(ctx context.Context) {
	backoff := time.Second
	var lastContact time.Time
	var lastConflict int64
	conflictBackoff := time.Second
	for ctx.Err() == nil {
		var sent bool
		var err error
		if time.Since(lastContact) >= HeartbeatInterval {
			err = p.heartbeat(ctx)
			sent = err == nil
		} else {
			sent, err = p.pushOnce(ctx)
		}
		var conflict *ConflictError
		switch {
		case errors.As(err, &conflict):
			lastContact = time.Now()
			last, lastErr := p.Store.LastSeq(ctx)
			if lastErr != nil {
				p.Log.Err(lastErr).Msg("Failed to read the journal")
				p.sleep(ctx, backoff)
				continue
			}
			// The gateway can only ask for a sequence the journal has (or the next one). Anything
			// else means the journal and the gateway disagree about history, which resending
			// can't fix: an operator has to look.
			if conflict.ExpectedSeq < 1 || conflict.ExpectedSeq > last+1 {
				p.Log.Error().Int64("expected_seq", conflict.ExpectedSeq).Int64("journal_last", last).
					Msg("Gateway asked for a sequence the journal doesn't have; not resending")
				p.sleep(ctx, maxBackoff)
				continue
			}
			// The same request again means the resend didn't help; back off rather than spin.
			if conflict.ExpectedSeq == lastConflict {
				p.Log.Error().Int64("expected_seq", conflict.ExpectedSeq).Dur("retry_in", conflictBackoff).
					Msg("Gateway keeps asking for the same sequence")
				// New journal events mustn't cut this short: they don't change what the gateway asks.
				p.sleepFull(ctx, conflictBackoff)
				conflictBackoff = min(conflictBackoff*2, maxBackoff)
			} else {
				p.Log.Warn().Int64("expected_seq", conflict.ExpectedSeq).Msg("Gateway asked to resend the journal from an earlier point")
				conflictBackoff = time.Second
			}
			lastConflict = conflict.ExpectedSeq
			if err = p.rewind(ctx, conflict.ExpectedSeq-1); err != nil {
				p.Log.Err(err).Msg("Failed to rewind journal acknowledgement")
			}
			continue
		case err != nil:
			p.pressure.failed(time.Now())
			p.Log.Warn().Err(err).Dur("retry_in", backoff).Msg("Failed to push events to the gateway")
			p.sleep(ctx, backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = time.Second
		lastConflict, conflictBackoff = 0, time.Second
		if sent {
			lastContact = time.Now()
			// A slow answer is the server struggling: give it as long again before the next.
			if wait := pace(p.pressure.lastTook()); wait > 0 {
				p.sleepFull(ctx, wait)
			}
		} else {
			p.sleep(ctx, min(idleWait, HeartbeatInterval-time.Since(lastContact)))
		}
	}
	p.sayStopping()
}

// stoppingTimeout bounds the last heartbeat, so a gateway that doesn't answer can't hold up
// the host's shutdown.
const stoppingTimeout = 3 * time.Second

// sayStopping sends a last heartbeat marked stopping, so the host shows offline at once rather
// than two minutes after its heartbeats stop. It is best effort: if it doesn't arrive, the
// missed heartbeats say the same, later. Nothing in the journal goes with it; what wasn't
// acknowledged is sent when the host starts again.
func (p *Pusher) sayStopping() {
	ctx, cancel := context.WithTimeout(context.Background(), stoppingTimeout)
	defer cancel()
	batch := p.batch(nil)
	batch.Stopping = true
	if _, err := p.Client.PostEvents(ctx, batch); err != nil {
		p.Log.Debug().Str("error_type", fmt.Sprintf("%T", err)).Msg("The gateway didn't get the stopping heartbeat")
	}
}

func (p *Pusher) sleep(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-p.wake:
	case <-timer.C:
	}
}

// sleepFull waits d unless ctx ends, whatever is appended to the journal meanwhile.
func (p *Pusher) sleepFull(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// rewind moves the acknowledgement back so events after seq are sent again.
func (p *Pusher) rewind(ctx context.Context, seq int64) error {
	return p.Store.SetAckedThrough(ctx, max(seq, 0))
}

// reconcile adopts the gateway's acknowledgement. Behind ours means the gateway lost
// events (for example a restore) and they are resent; ahead of the journal can't be
// fixed here and is reported. It also notes how the delivery went (took, and what's left).
func (p *Pusher) reconcile(ctx context.Context, ackedThrough int64, took time.Duration) error {
	acked, err := p.Store.AckedThrough(ctx)
	if err != nil {
		return err
	}
	last, err := p.Store.LastSeq(ctx)
	if err != nil {
		return err
	}
	p.pressure.pushed(took, last-ackedThrough)
	switch {
	case ackedThrough > last:
		return fmt.Errorf("gateway has acknowledged seq %d but the journal ends at %d; the journal was reset or restored", ackedThrough, last)
	case ackedThrough != acked:
		if ackedThrough < acked {
			p.Log.Warn().Int64("gateway", ackedThrough).Int64("local", acked).Msg("Gateway is behind the journal; resending")
		}
		// This also scrubs a login's QR or pairing code from what the gateway now has.
		if err = p.Store.SetAckedThrough(ctx, ackedThrough); err != nil {
			return err
		}
	}
	return nil
}

func (p *Pusher) batch(events []*protocol.Event) *protocol.EventBatch {
	if events == nil {
		events = []*protocol.Event{}
	}
	return &protocol.EventBatch{
		HostID: p.HostID, Network: p.Network, CommandAddr: p.CommandAddr, Events: events,
		Pressure: p.pressure.snapshot(time.Now()),
	}
}

// post sends a batch, and says how long it took to be answered.
func (p *Pusher) post(ctx context.Context, batch *protocol.EventBatch) (int64, time.Duration, error) {
	start := time.Now()
	ackedThrough, err := p.Client.PostEvents(ctx, batch)
	return ackedThrough, time.Since(start), err
}

// heartbeat sends an empty batch and adopts the gateway's acknowledgement.
func (p *Pusher) heartbeat(ctx context.Context) error {
	ackedThrough, took, err := p.post(ctx, p.batch(nil))
	if err != nil {
		return err
	}
	return p.reconcile(ctx, ackedThrough, took)
}

// ErrNoProgress is a batch the gateway took without acknowledging any of it.
var ErrNoProgress = errors.New("gateway acknowledged none of the batch")

// pushOnce sends the next batch, if any. It reports whether anything was sent. The gateway
// may acknowledge only part of a batch (it stops early to stay inside its own limits); the
// rest is sent again next time, which is normal progress. Only an acknowledgement that
// doesn't move at all is an error, so the caller backs off instead of resending at once.
func (p *Pusher) pushOnce(ctx context.Context) (bool, error) {
	acked, err := p.Store.AckedThrough(ctx)
	if err != nil {
		return false, err
	}
	events, err := p.Store.After(ctx, acked, p.BatchSize)
	if err != nil || len(events) == 0 {
		return false, err
	}
	events = p.capBytes(events, MaxBatchBytes)
	ackedThrough, took, err := p.post(ctx, p.batch(events))
	if err != nil {
		return false, err
	}
	if err = p.reconcile(ctx, ackedThrough, took); err != nil {
		return true, err
	}
	if ackedThrough <= acked {
		return true, ErrNoProgress
	}
	return true, nil
}

// capBytes keeps the leading events whose JSON fits in limit, and always at least one. An
// event over protocol.MaxEventBytes (only a journal row from before the host enforced the
// limit can be) goes as a bare stand-in: the gateway quarantines it, as it would the whole
// event, and the journal moves on instead of being stuck behind a body it refuses.
func (p *Pusher) capBytes(events []*protocol.Event, limit int) []*protocol.Event {
	total := 0
	for i, evt := range events {
		data, err := json.Marshal(evt)
		if err == nil && len(data) > protocol.MaxEventBytes {
			p.Log.Warn().Int64("seq", evt.Seq).Str("event_type", evt.Type).Int("bytes", len(data)).
				Msg("Journal event is too large to send; sending a stand-in for the gateway to quarantine")
			events[i] = protocol.Bare(evt)
			data, err = json.Marshal(events[i])
		}
		if err != nil {
			return events[:max(i, 1)]
		}
		total += len(data) + 1
		if total > limit && i > 0 {
			return events[:i]
		}
	}
	return events
}

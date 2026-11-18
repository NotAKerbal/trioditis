// Package store holds the bridge host's own tables, next to bridgev2's in the same
// database: the event journal, command dedup, outgoing send state, the opaque ID map, the
// recipient key cache and room membership.
//
// Nothing here holds plaintext content. Journal payloads are protocol events whose content
// fields are sealed envelopes; everything else is IDs, statuses and public keys.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/util/dbutil"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

var upgrades = dbutil.BuildUpgradeTable().
	WithRaw(0, 1, 0, "Initial Trioditis tables", dbutil.TxnModeOn, func(ctx context.Context, db *dbutil.Database) error {
		seqColumn := "seq INTEGER PRIMARY KEY AUTOINCREMENT"
		if db.Dialect == dbutil.Postgres {
			seqColumn = "seq BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY"
		}
		statements := []string{
			`CREATE TABLE trioditis_journal (` + seqColumn + `, payload TEXT NOT NULL, created_at BIGINT NOT NULL)`,
			`CREATE TABLE trioditis_journal_state (id INTEGER PRIMARY KEY, acked_through BIGINT NOT NULL)`,
			`INSERT INTO trioditis_journal_state (id, acked_through) VALUES (1, 0)`,
			`CREATE TABLE trioditis_command (command_id TEXT PRIMARY KEY, received_at BIGINT NOT NULL)`,
			`CREATE TABLE trioditis_outgoing (
				user_id           TEXT   NOT NULL,
				login_id          TEXT   NOT NULL,
				client_message_id TEXT   NOT NULL,
				event_id          TEXT   NOT NULL,
				status            TEXT   NOT NULL,
				error             TEXT   NOT NULL DEFAULT '',
				updated_at        BIGINT NOT NULL,
				PRIMARY KEY (user_id, client_message_id)
			)`,
			`CREATE INDEX trioditis_outgoing_event_idx ON trioditis_outgoing (event_id)`,
			`CREATE TABLE trioditis_id (opaque TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL)`,
			`CREATE TABLE trioditis_recipient_keys (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at BIGINT NOT NULL)`,
			`CREATE TABLE trioditis_member (room_id TEXT NOT NULL, mxid TEXT NOT NULL, PRIMARY KEY (room_id, mxid))`,
			`CREATE INDEX trioditis_member_mxid_idx ON trioditis_member (mxid)`,
			`CREATE TABLE trioditis_reaction (event_id TEXT PRIMARY KEY, target_event_id TEXT NOT NULL, reaction_key TEXT NOT NULL)`,
		}
		for _, statement := range statements {
			if _, err := db.Exec(ctx, statement); err != nil {
				return err
			}
		}
		return nil
	}).
	Finish()

// Store is the bridge host's own tables.
type Store struct {
	DB *dbutil.Database
}

// New makes the store a child of the bridge's database, with its own version table.
func New(db *dbutil.Database, log dbutil.DatabaseLogger) *Store {
	return &Store{DB: db.Child("trioditis_version", upgrades, log)}
}

// Upgrade creates or migrates the tables.
func (s *Store) Upgrade(ctx context.Context) error {
	return s.DB.Upgrade(ctx)
}

// Append writes an event to the journal and sets its sequence number. The caller must
// only pass events whose content is already sealed.
func (s *Store) Append(ctx context.Context, evt *protocol.Event) error {
	evt.Seq = 0
	payload, err := json.Marshal(evt)
	if err != nil {
		return err
	}
	var seq int64
	err = s.DB.QueryRow(ctx,
		`INSERT INTO trioditis_journal (payload, created_at) VALUES ($1, $2) RETURNING seq`,
		string(payload), time.Now().UnixMilli(),
	).Scan(&seq)
	if err != nil {
		return fmt.Errorf("failed to append to journal: %w", err)
	}
	evt.Seq = seq
	return nil
}

// After returns up to limit journal events with a sequence number above seq, in order.
func (s *Store) After(ctx context.Context, seq int64, limit int) ([]*protocol.Event, error) {
	rows, err := s.DB.Query(ctx, `SELECT seq, payload FROM trioditis_journal WHERE seq > $1 ORDER BY seq LIMIT $2`, seq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []*protocol.Event
	for rows.Next() {
		var rowSeq int64
		var payload string
		if err = rows.Scan(&rowSeq, &payload); err != nil {
			return nil, err
		}
		var evt protocol.Event
		if err = json.Unmarshal([]byte(payload), &evt); err != nil {
			return nil, fmt.Errorf("journal row %d is corrupt: %w", rowSeq, err)
		}
		evt.Seq = rowSeq
		events = append(events, &evt)
	}
	return events, rows.Err()
}

// AckedThrough is the highest sequence number the gateway has committed.
func (s *Store) AckedThrough(ctx context.Context) (int64, error) {
	var acked int64
	err := s.DB.QueryRow(ctx, `SELECT acked_through FROM trioditis_journal_state WHERE id=1`).Scan(&acked)
	return acked, err
}

// SetAckedThrough records the gateway's acknowledgement.
func (s *Store) SetAckedThrough(ctx context.Context, seq int64) error {
	_, err := s.DB.Exec(ctx, `UPDATE trioditis_journal_state SET acked_through=$1 WHERE id=1`, seq)
	return err
}

// LastSeq is the highest sequence number in the journal, or 0.
func (s *Store) LastSeq(ctx context.Context) (int64, error) {
	var seq sql.NullInt64
	err := s.DB.QueryRow(ctx, `SELECT MAX(seq) FROM trioditis_journal`).Scan(&seq)
	return seq.Int64, err
}

// ClaimCommand records a command ID. It returns false if the ID was seen before, so a
// repeated command isn't run twice.
func (s *Store) ClaimCommand(ctx context.Context, commandID string) (bool, error) {
	res, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_command (command_id, received_at) VALUES ($1, $2) ON CONFLICT (command_id) DO NOTHING`,
		commandID, time.Now().UnixMilli(),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ReleaseCommand forgets a command ID, for a command refused before it ran, so the
// gateway may send it again once the refusal is fixed.
func (s *Store) ReleaseCommand(ctx context.Context, commandID string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM trioditis_command WHERE command_id=$1`, commandID)
	return err
}

// Outgoing is the state of a send from Trioditis.
type Outgoing struct {
	UserID          string
	LoginID         string
	ClientMessageID string
	EventID         string
	Status          string
	Error           string
}

var ErrNotFound = errors.New("store: not found")

const outgoingColumns = `user_id, login_id, client_message_id, event_id, status, error`

func scanOutgoing(row interface{ Scan(...any) error }) (*Outgoing, error) {
	var out Outgoing
	err := row.Scan(&out.UserID, &out.LoginID, &out.ClientMessageID, &out.EventID, &out.Status, &out.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &out, err
}

// GetOutgoing looks a send up by its client message ID.
func (s *Store) GetOutgoing(ctx context.Context, userID, clientMessageID string) (*Outgoing, error) {
	return scanOutgoing(s.DB.QueryRow(ctx,
		`SELECT `+outgoingColumns+` FROM trioditis_outgoing WHERE user_id=$1 AND client_message_id=$2`, userID, clientMessageID))
}

// GetOutgoingByEvent looks a send up by its event ID.
func (s *Store) GetOutgoingByEvent(ctx context.Context, eventID string) (*Outgoing, error) {
	return scanOutgoing(s.DB.QueryRow(ctx, `SELECT `+outgoingColumns+` FROM trioditis_outgoing WHERE event_id=$1`, eventID))
}

// InsertOutgoing records a new send. It returns false if one with the same client
// message ID exists.
func (s *Store) InsertOutgoing(ctx context.Context, out *Outgoing) (bool, error) {
	res, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_outgoing (`+outgoingColumns+`, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (user_id, client_message_id) DO NOTHING`,
		out.UserID, out.LoginID, out.ClientMessageID, out.EventID, out.Status, out.Error, time.Now().UnixMilli(),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// SetOutgoingStatus updates a send's status.
func (s *Store) SetOutgoingStatus(ctx context.Context, userID, clientMessageID, status, errMsg string) error {
	_, err := s.DB.Exec(ctx,
		`UPDATE trioditis_outgoing SET status=$3, error=$4, updated_at=$5 WHERE user_id=$1 AND client_message_id=$2`,
		userID, clientMessageID, status, errMsg, time.Now().UnixMilli(),
	)
	return err
}

// OutgoingInFlight lists sends whose outcome wasn't recorded, such as those interrupted by
// a restart.
func (s *Store) OutgoingInFlight(ctx context.Context) ([]*Outgoing, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+outgoingColumns+` FROM trioditis_outgoing WHERE status=$1`, protocol.StatusSubmitted)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Outgoing
	for rows.Next() {
		o, err := scanOutgoing(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// PutID records what an opaque ID stands for.
func (s *Store) PutID(ctx context.Context, opaque, kind, value string) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_id (opaque, kind, value) VALUES ($1, $2, $3) ON CONFLICT (opaque) DO NOTHING`,
		opaque, kind, value,
	)
	return err
}

// LookupID returns what an opaque ID stands for.
func (s *Store) LookupID(ctx context.Context, opaque, kind string) (string, error) {
	var value string
	err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_id WHERE opaque=$1 AND kind=$2`, opaque, kind).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return value, err
}

// GetRecipientKeys returns the cached public keys for a user.
func (s *Store) GetRecipientKeys(ctx context.Context, userID string) (*protocol.RecipientKeys, time.Time, error) {
	var payload string
	var fetchedAt int64
	err := s.DB.QueryRow(ctx, `SELECT payload, fetched_at FROM trioditis_recipient_keys WHERE user_id=$1`, userID).Scan(&payload, &fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	} else if err != nil {
		return nil, time.Time{}, err
	}
	var keys protocol.RecipientKeys
	if err = json.Unmarshal([]byte(payload), &keys); err != nil {
		return nil, time.Time{}, err
	}
	return &keys, time.UnixMilli(fetchedAt), nil
}

// PutRecipientKeys caches a user's public keys. They aren't secret; caching them lets the
// bridge host keep sealing while the gateway is unreachable.
func (s *Store) PutRecipientKeys(ctx context.Context, userID string, keys *protocol.RecipientKeys) error {
	payload, err := json.Marshal(keys)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx,
		`INSERT INTO trioditis_recipient_keys (user_id, payload, fetched_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
		userID, string(payload), time.Now().UnixMilli(),
	)
	return err
}

// AddMember records that a Matrix-shaped user is in a room. It returns true if they
// weren't before.
func (s *Store) AddMember(ctx context.Context, roomID, mxid string) (bool, error) {
	res, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_member (room_id, mxid) VALUES ($1, $2) ON CONFLICT (room_id, mxid) DO NOTHING`, roomID, mxid)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// RemoveMember records that a user left a room.
func (s *Store) RemoveMember(ctx context.Context, roomID, mxid string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM trioditis_member WHERE room_id=$1 AND mxid=$2`, roomID, mxid)
	return err
}

// Members lists a room's members.
func (s *Store) Members(ctx context.Context, roomID string) ([]string, error) {
	return s.strings(ctx, `SELECT mxid FROM trioditis_member WHERE room_id=$1`, roomID)
}

// RoomsOf lists the rooms a user is in.
func (s *Store) RoomsOf(ctx context.Context, mxid string) ([]string, error) {
	return s.strings(ctx, `SELECT room_id FROM trioditis_member WHERE mxid=$1`, mxid)
}

func (s *Store) strings(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.DB.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, rows.Err()
}

// PutReaction records a reaction event's target and key, so its removal can be reported
// with them. Reaction keys are metadata, not sealed content, per the protocol.
func (s *Store) PutReaction(ctx context.Context, eventID, targetEventID, key string) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_reaction (event_id, target_event_id, reaction_key) VALUES ($1, $2, $3)
		 ON CONFLICT (event_id) DO UPDATE SET target_event_id=excluded.target_event_id, reaction_key=excluded.reaction_key`,
		eventID, targetEventID, key,
	)
	return err
}

// GetReaction returns a reaction's target and key.
func (s *Store) GetReaction(ctx context.Context, eventID string) (target, key string, err error) {
	err = s.DB.QueryRow(ctx, `SELECT target_event_id, reaction_key FROM trioditis_reaction WHERE event_id=$1`, eventID).Scan(&target, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return
}

// DeleteReaction forgets a removed reaction.
func (s *Store) DeleteReaction(ctx context.Context, eventID string) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM trioditis_reaction WHERE event_id=$1`, eventID)
	return err
}

// Package store holds the bridge host's own tables, next to bridgev2's in the same
// database: the event journal, the command queue, outgoing send state, the opaque ID map,
// the recipient key cache and room membership.
//
// Nothing here holds plaintext content. Journal payloads are protocol events whose content
// fields are sealed envelopes. A queued command's payload is sealed to the bridge key and is
// deleted once the command has run. Everything else is IDs, statuses and public keys.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/util/dbutil"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
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
		return execAll(ctx, db, statements)
	}).
	WithRaw(1, 2, 0, "Gap-free journal, durable command queue, dedicated ID key", dbutil.TxnModeOn, func(ctx context.Context, db *dbutil.Database) error {
		statements := []string{
			// Sequence numbers are allocated in the appending transaction, from this counter,
			// so a rolled-back append leaves no gap. (A database sequence keeps values a
			// rollback discarded, and the gateway would wait for them forever.)
			`ALTER TABLE trioditis_journal_state ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 1`,
			`UPDATE trioditis_journal_state SET next_seq=COALESCE((SELECT MAX(seq) FROM trioditis_journal), 0) + 1`,
			`ALTER TABLE trioditis_journal_state ADD COLUMN next_command BIGINT NOT NULL DEFAULT 1`,
			// A command is stored, payload included, before it is acknowledged. Existing rows
			// were run already.
			`ALTER TABLE trioditis_command ADD COLUMN queue_order BIGINT NOT NULL DEFAULT 0`,
			`ALTER TABLE trioditis_command ADD COLUMN state TEXT NOT NULL DEFAULT 'done'`,
			`ALTER TABLE trioditis_command ADD COLUMN payload TEXT NOT NULL DEFAULT ''`,
			`CREATE INDEX trioditis_command_state_idx ON trioditis_command (state, queue_order)`,
			`CREATE TABLE trioditis_secret (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		}
		if db.Dialect == dbutil.Postgres {
			statements = append(statements, `ALTER TABLE trioditis_journal ALTER COLUMN seq DROP IDENTITY`)
		}
		if err := execAll(ctx, db, statements); err != nil {
			return err
		}
		return migratePortalValues(ctx, db)
	}).
	Finish()

func execAll(ctx context.Context, db *dbutil.Database, statements []string) error {
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

// migratePortalValues replaces stored portal values (the portal key, with a NUL that
// PostgreSQL's TEXT refuses) with the portal's room ID. The opaque IDs don't change.
func migratePortalValues(ctx context.Context, db *dbutil.Database) error {
	rows, err := db.Query(ctx, `SELECT opaque, value FROM trioditis_id WHERE kind=$1`, ids.KindPortal)
	if err != nil {
		return err
	}
	type pair struct{ opaque, value string }
	var pending []pair
	for rows.Next() {
		var p pair
		if err = rows.Scan(&p.opaque, &p.value); err != nil {
			_ = rows.Close()
			return err
		}
		if strings.Contains(p.value, "\x00") {
			pending = append(pending, p)
		}
	}
	if err = rows.Close(); err != nil {
		return err
	}
	for _, p := range pending {
		roomID := string(ids.RoomID(ids.ParsePortalValue(p.value)))
		if _, err = db.Exec(ctx, `UPDATE trioditis_id SET value=$1 WHERE opaque=$2`, roomID, p.opaque); err != nil {
			return err
		}
	}
	return nil
}

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

// Txn runs fn in one transaction. Store calls inside it join the transaction, so a state
// change and the journal events reporting it commit together or not at all.
func (s *Store) Txn(ctx context.Context, fn func(ctx context.Context) error) error {
	return s.DB.DoTxn(ctx, nil, fn)
}

// lockCounters reads the journal state row, locking it on PostgreSQL so concurrent
// transactions take sequence numbers one at a time. (SQLite transactions are already
// serialized: the database is opened with _txlock=immediate.)
func (s *Store) lockCounters(ctx context.Context, column string) (int64, error) {
	query := `SELECT ` + column + ` FROM trioditis_journal_state WHERE id=1`
	if s.DB.Dialect == dbutil.Postgres {
		query += ` FOR UPDATE`
	}
	var value int64
	err := s.DB.QueryRow(ctx, query).Scan(&value)
	return value, err
}

// Append writes events to the journal in one transaction and sets their sequence numbers.
// The caller must only pass events whose content is already sealed.
func (s *Store) Append(ctx context.Context, events ...*protocol.Event) error {
	if len(events) == 0 {
		return nil
	}
	err := s.Txn(ctx, func(ctx context.Context) error {
		next, err := s.lockCounters(ctx, "next_seq")
		if err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		for i, evt := range events {
			evt.Seq = 0
			payload, err := json.Marshal(evt)
			if err != nil {
				return err
			}
			if _, err = s.DB.Exec(ctx,
				`INSERT INTO trioditis_journal (seq, payload, created_at) VALUES ($1, $2, $3)`,
				next+int64(i), string(payload), now,
			); err != nil {
				return err
			}
		}
		_, err = s.DB.Exec(ctx, `UPDATE trioditis_journal_state SET next_seq=$1 WHERE id=1`, next+int64(len(events)))
		if err == nil {
			for i, evt := range events {
				evt.Seq = next + int64(i)
			}
		}
		return err
	})
	if err != nil {
		for _, evt := range events {
			evt.Seq = 0
		}
		return fmt.Errorf("failed to append to journal: %w", err)
	}
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

// ScrubLoginDisplays removes what a login step showed (a QR code or pairing code, which
// is enough to link a device while it is valid) from journal events the gateway has
// acknowledged. Nothing needs it after that.
func (s *Store) ScrubLoginDisplays(ctx context.Context, throughSeq int64) error {
	rows, err := s.DB.Query(ctx,
		`SELECT seq, payload FROM trioditis_journal WHERE seq <= $1 AND payload LIKE $2`,
		throughSeq, `%"display":{%"data":%`,
	)
	if err != nil {
		return err
	}
	type update struct {
		seq     int64
		payload string
	}
	var updates []update
	for rows.Next() {
		var u update
		if err = rows.Scan(&u.seq, &u.payload); err != nil {
			_ = rows.Close()
			return err
		}
		var evt protocol.Event
		if json.Unmarshal([]byte(u.payload), &evt) != nil || evt.Step == nil || evt.Step.Display == nil || evt.Step.Display.Data == "" {
			continue
		}
		evt.Step.Display.Data = ""
		data, err := json.Marshal(&evt)
		if err != nil {
			continue
		}
		u.payload = string(data)
		updates = append(updates, u)
	}
	if err = rows.Close(); err != nil {
		return err
	}
	for _, u := range updates {
		if _, err = s.DB.Exec(ctx, `UPDATE trioditis_journal SET payload=$1 WHERE seq=$2`, u.payload, u.seq); err != nil {
			return err
		}
	}
	return nil
}

// Command states.
const (
	CommandQueued  = "queued"  // stored and acknowledged, not started
	CommandStarted = "started" // being run; a restart doesn't run it again
	CommandDone    = "done"    // run, or settled; the payload is gone
)

// HasCommand reports whether a command ID was stored before.
func (s *Store) HasCommand(ctx context.Context, commandID string) (bool, error) {
	var exists bool
	err := s.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM trioditis_command WHERE command_id=$1)`, commandID).Scan(&exists)
	return exists, err
}

// QueuedCommand is a command waiting to run.
type QueuedCommand struct {
	Order   int64
	Command *protocol.Command
}

// EnqueueCommand stores a command, payload included, for the worker to run. It returns
// false if the command ID was seen before, in which case nothing is stored: the command is
// already queued or has run.
func (s *Store) EnqueueCommand(ctx context.Context, cmd *protocol.Command) (bool, error) {
	payload, err := json.Marshal(cmd)
	if err != nil {
		return false, err
	}
	var inserted bool
	err = s.Txn(ctx, func(ctx context.Context) error {
		order, err := s.lockCounters(ctx, "next_command")
		if err != nil {
			return err
		}
		res, err := s.DB.Exec(ctx,
			`INSERT INTO trioditis_command (command_id, received_at, queue_order, state, payload) VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (command_id) DO NOTHING`,
			cmd.CommandID, time.Now().UnixMilli(), order, CommandQueued, string(payload),
		)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		inserted = true
		_, err = s.DB.Exec(ctx, `UPDATE trioditis_journal_state SET next_command=$1 WHERE id=1`, order+1)
		return err
	})
	return inserted, err
}

func (s *Store) commandsIn(ctx context.Context, state string) ([]*QueuedCommand, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT queue_order, payload FROM trioditis_command WHERE state=$1 ORDER BY queue_order`, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*QueuedCommand
	for rows.Next() {
		var qc QueuedCommand
		var payload string
		if err = rows.Scan(&qc.Order, &payload); err != nil {
			return nil, err
		}
		qc.Command = &protocol.Command{}
		if err = json.Unmarshal([]byte(payload), qc.Command); err != nil {
			return nil, fmt.Errorf("queued command %d is corrupt: %w", qc.Order, err)
		}
		out = append(out, &qc)
	}
	return out, rows.Err()
}

// QueuedCommands lists commands waiting to run, in the order they arrived.
func (s *Store) QueuedCommands(ctx context.Context) ([]*QueuedCommand, error) {
	return s.commandsIn(ctx, CommandQueued)
}

// StartedCommands lists commands that were being run when the process stopped.
func (s *Store) StartedCommands(ctx context.Context) ([]*QueuedCommand, error) {
	return s.commandsIn(ctx, CommandStarted)
}

// SetCommandState moves a command on. Finishing it deletes its payload: whatever it carried
// (a message or login input, sealed to the bridge key) isn't kept once used. A started
// command keeps its payload, in case a restart puts it back in the queue.
func (s *Store) SetCommandState(ctx context.Context, commandID, state string) error {
	query := `UPDATE trioditis_command SET state=$2 WHERE command_id=$1`
	if state == CommandDone {
		query = `UPDATE trioditis_command SET state=$2, payload='' WHERE command_id=$1`
	}
	_, err := s.DB.Exec(ctx, query, commandID, state)
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
// a restart. A send's status and the event reporting it commit together, so `submitted` is
// the only state a send can be left in.
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

// PutID records what an opaque ID stands for. Values never contain NUL.
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

const opaqueIDKeyName = "opaque_id_key"

// IDKey is the key opaque IDs are hashed with, created once per database and kept: the
// IDs must never change, whatever happens to the bridge key. A database that already has
// IDs keeps the key they were made with (legacy, derived from the bridge key by the first
// bridge hosts).
func (s *Store) IDKey(ctx context.Context, legacy []byte) ([]byte, error) {
	var key []byte
	err := s.Txn(ctx, func(ctx context.Context) error {
		var stored string
		err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_secret WHERE name=$1`, opaqueIDKeyName).Scan(&stored)
		if err == nil {
			key, err = base64.RawURLEncoding.DecodeString(stored)
			return err
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var existing int
		if err = s.DB.QueryRow(ctx, `SELECT COUNT(*) FROM trioditis_id`).Scan(&existing); err != nil {
			return err
		}
		if existing > 0 {
			key = append([]byte(nil), legacy...)
		} else {
			key = make([]byte, 32)
			if _, err = rand.Read(key); err != nil {
				return err
			}
		}
		_, err = s.DB.Exec(ctx, `INSERT INTO trioditis_secret (name, value) VALUES ($1, $2)`,
			opaqueIDKeyName, base64.RawURLEncoding.EncodeToString(key))
		return err
	})
	return key, err
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

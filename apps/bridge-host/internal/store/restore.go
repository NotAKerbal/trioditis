package store

import (
	"context"
	"database/sql"
	"errors"
)

// settledRestoreName is where the last restore whose commands this database has settled is
// kept, beside the other per-database values.
const settledRestoreName = "settled_restore_id"

// SettledRestore is the ID of the last restore (deploy/trioditis restore, RESTORE_ID) whose
// restored commands this database has settled, or "" if none has been.
func (s *Store) SettledRestore(ctx context.Context) (string, error) {
	var id string
	err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_secret WHERE name=$1`, settledRestoreName).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// SetSettledRestore records that this database's commands have been settled for restore id.
func (s *Store) SetSettledRestore(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_secret (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value=excluded.value`,
		settledRestoreName, id)
	return err
}

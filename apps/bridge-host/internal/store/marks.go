package store

import (
	"context"
	"database/sql"
	"errors"
)

// Marks record that a one-time piece of work on this database is done. They are kept beside
// the other per-database values, under a "done:" prefix.
const markPrefix = "done:"

// Marked reports whether Mark has recorded name.
func (s *Store) Marked(ctx context.Context, name string) (bool, error) {
	var value string
	err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_secret WHERE name=$1`, markPrefix+name).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Mark records that the work called name is done.
func (s *Store) Mark(ctx context.Context, name string) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_secret (name, value) VALUES ($1, '1') ON CONFLICT (name) DO NOTHING`, markPrefix+name)
	return err
}

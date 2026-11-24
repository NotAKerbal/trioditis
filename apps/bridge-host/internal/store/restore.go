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

// describedDirectChatsName marks that every direct chat this database had was described again
// once its metadata said who the chat is with (Connector.DescribeDirectChats).
const describedDirectChatsName = "described_direct_chats"

// DescribedDirectChats reports whether DescribeDirectChats has finished on this database.
func (s *Store) DescribedDirectChats(ctx context.Context) (bool, error) {
	var value string
	err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_secret WHERE name=$1`, describedDirectChatsName).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// SetDescribedDirectChats records that DescribeDirectChats has finished on this database.
func (s *Store) SetDescribedDirectChats(ctx context.Context) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_secret (name, value) VALUES ($1, '1') ON CONFLICT (name) DO NOTHING`,
		describedDirectChatsName)
	return err
}

// repairedContactAvatarsName marks that the contacts sent without their picture, because it
// was uploaded too long before, have been sent it (Connector.RepairContactAvatars).
const repairedContactAvatarsName = "repaired_contact_avatars"

// RepairedContactAvatars reports whether RepairContactAvatars has finished on this database.
func (s *Store) RepairedContactAvatars(ctx context.Context) (bool, error) {
	var value string
	err := s.DB.QueryRow(ctx, `SELECT value FROM trioditis_secret WHERE name=$1`, repairedContactAvatarsName).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// SetRepairedContactAvatars records that RepairContactAvatars has finished on this database.
func (s *Store) SetRepairedContactAvatars(ctx context.Context) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO trioditis_secret (name, value) VALUES ($1, '1') ON CONFLICT (name) DO NOTHING`,
		repairedContactAvatarsName)
	return err
}

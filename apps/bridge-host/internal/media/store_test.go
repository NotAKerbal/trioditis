package media

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

func readAll(t *testing.T, f *os.File) []byte {
	t.Helper()
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestOpenGivesAnOwnerTheirCopyOnly(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	uri := store.Upload([]byte("a photo"), "photo.jpg", "image/jpeg")
	att, err := store.AttachmentFor(uri, "alice")
	if err != nil {
		t.Fatal(err)
	}
	f, err := store.Open(att.MediaID, "alice")
	if err != nil {
		t.Fatal(err)
	}
	got, err := seal.DecryptMedia(readAll(t, f), att.Key, att.Nonce, "alice", att.MediaID)
	if err != nil || string(got) != "a photo" {
		t.Fatalf("alice's copy opens to %q, %v", got, err)
	}
	if _, err = store.Open(att.MediaID, "bob"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("bob opening alice's copy: %v, want ErrUnavailable", err)
	}
	if _, err = store.Open(att.MediaID, ""); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("nobody opening alice's copy: %v, want ErrUnavailable", err)
	}
}

func TestOpenFindsACopyFromBeforeOwnerDirectories(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	const mediaID = "legacyMediaId_0123456789"
	if err = os.WriteFile(filepath.Join(dir, mediaID), []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := store.Open(mediaID, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, f); !bytes.Equal(got, []byte("ciphertext")) {
		t.Fatalf("got %q", got)
	}
}

func TestOpenRefusesPathsAndLinks(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err = os.WriteFile(outside, []byte("not media"), 0o600); err != nil {
		t.Fatal(err)
	}
	const linked = "linkedMediaId_0123456789"
	if err = os.Symlink(outside, filepath.Join(dir, linked)); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(dir, "aDirectoryNotAFile_0123"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{linked, "aDirectoryNotAFile_0123", "../secret", "owners", "short", ""} {
		if f, err := store.Open(id, "alice"); !errors.Is(err, ErrUnavailable) {
			if f != nil {
				_ = f.Close()
			}
			t.Errorf("Open(%q): %v, want ErrUnavailable", id, err)
		}
	}
}

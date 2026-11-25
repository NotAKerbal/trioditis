package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
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

func TestPutFileIsReadForItsOwnersSendOnly(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const mediaID = "clientMediaId_0123456789"
	enc, err := seal.EncryptMedia([]byte("a photo"), "alice", mediaID)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Put(mediaID, "alice", bytes.NewReader(enc.Ciphertext)); err != nil {
		t.Fatal(err)
	}
	if err = store.Put(mediaID, "alice", strings.NewReader("other")); !errors.Is(err, ErrExists) {
		t.Fatalf("second put: %v, want ErrExists", err)
	}
	att := protocol.Attachment{MediaID: mediaID, Key: enc.Key, Nonce: enc.Nonce}
	uri, err := store.Register(att, "alice", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := store.Read(uri); err != nil || string(got) != "a photo" {
		t.Fatalf("alice's send reads %q, %v", got, err)
	}
	// Bob naming alice's file, even with its key, finds nothing in his own directory, and his
	// registration of the same ID leaves hers reading her file.
	bobURI, err := store.Register(att, "bob", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if bobURI == uri {
		t.Fatal("two sends of one media ID share a content URI")
	}
	if _, err = store.Read(bobURI); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("bob's send read alice's file: %v", err)
	}
	if got, err := store.Read(uri); err != nil || string(got) != "a photo" {
		t.Fatalf("after bob's registration, alice's send reads %q, %v", got, err)
	}
}

func TestSendsWaitForTheirShareOfTheBudget(t *testing.T) {
	b := newBudget(10)
	first, err := b.acquire(context.Background(), 8)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err = b.acquire(ctx, 4); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("over the budget: %v, want to wait until the deadline", err)
	}
	got := make(chan func(), 1)
	go func() {
		// Larger than the whole budget: it waits for all of it.
		giveBack, _ := b.acquire(context.Background(), 100)
		got <- giveBack
	}()
	first()
	first() // giving back twice gives back once
	select {
	case giveBack := <-got:
		giveBack()
	case <-time.After(time.Second):
		t.Fatal("a share wasn't given once the budget was free")
	}
	if b.free != 10 {
		t.Fatalf("free %d, want 10", b.free)
	}
}

func TestPutRefusesBadIDsAndLargeFiles(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"short", "../../escapeMediaId_01234", ".put-0123456789abcdef"} {
		if err = store.Put(id, "alice", strings.NewReader("x")); !errors.Is(err, ErrUnavailable) {
			t.Errorf("put %q: %v, want ErrUnavailable", id, err)
		}
	}
	big := io.LimitReader(zeros{}, MaxClientFile+1)
	if err = store.Put("bigMediaId_0123456789", "alice", big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("big put: %v, want ErrTooLarge", err)
	}
	if _, err = store.Open("bigMediaId_0123456789", "alice"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a refused put was kept: %v", err)
	}
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// The bridge host's own copy of an upload outlives it, and a person's copy can be made from it
// after a restart; but nobody can fetch the host's copy itself, and its plaintext is never on disk.
func TestAKeptCopyMakesAnOwnersCopyLaterButIsNeverServed(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("a contact's picture")
	uri := store.Upload(plaintext, "avatar.jpg", "image/jpeg")
	kept, err := store.Keep(uri)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := store.Keep(uri); err != nil || *again != *kept {
		t.Fatalf("keeping again made another copy: %+v, %v", again, err)
	}
	if _, err := store.Open(kept.MediaID, "alice"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("the kept copy was served: %v", err)
	}
	if _, err := store.Open(kept.MediaID, KeptOwner); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("the kept copy was served to its own owner name: %v", err)
	}
	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err == nil && bytes.Contains(data, plaintext) {
			t.Errorf("plaintext on disk in %s", path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	// A restart: the upload is gone, the kept copy isn't.
	restarted, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Keep(uri); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("an upload outlived the restart: %v", err)
	}
	att, err := restarted.CopyKept(*kept, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if att.MediaID == kept.MediaID || att.Key == kept.Key || att.Mime != "image/jpeg" || att.Name != "avatar.jpg" || att.Size != len(plaintext) {
		t.Fatalf("alice's copy: %+v", att)
	}
	f, err := restarted.Open(att.MediaID, "alice")
	if err != nil {
		t.Fatal(err)
	}
	got, err := seal.DecryptMedia(readAll(t, f), att.Key, att.Nonce, "alice", att.MediaID)
	if err != nil || !bytes.Equal(got, plaintext) {
		t.Fatalf("alice's copy opened to %q, %v", got, err)
	}
	if _, err := restarted.Open(att.MediaID, "bob"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("alice's copy was served to bob")
	}
	// A kept reference with the wrong key opens nothing.
	forged := *kept
	forged.Key = att.Key
	if _, err := restarted.CopyKept(forged, "alice"); err == nil {
		t.Fatal("a kept copy opened with another key")
	}
	// One whose file is gone is no copy at all.
	if has, err := restarted.HasKept(*kept); !has || err != nil {
		t.Fatal("the kept copy isn't there")
	}
	if err := os.Remove(filepath.Join(dir, "kept", kept.MediaID)); err != nil {
		t.Fatal(err)
	}
	if has, err := restarted.HasKept(*kept); has || err != nil {
		t.Fatal("a kept copy with no file counted")
	}
}

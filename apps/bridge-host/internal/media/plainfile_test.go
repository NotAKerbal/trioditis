package media

import (
	"errors"
	"os"
	"testing"
)

func TestPlainFilesOnlyInMemory(t *testing.T) {
	saved := PlainFileDirs
	t.Cleanup(func() { PlainFileDirs = saved })

	PlainFileDirs = []string{t.TempDir()}
	if IsMemoryBacked(PlainFileDirs[0]) {
		t.Skip("the test temp directory is itself on tmpfs")
	}
	if _, err := TempPlainFile(); !errors.Is(err, ErrNoMemoryStorage) {
		t.Fatalf("a plaintext file on disk must be refused, got %v", err)
	}

	PlainFileDirs = saved
	if !IsMemoryBacked("/dev/shm") {
		t.Skip("/dev/shm isn't tmpfs here")
	}
	f, err := TempPlainFile()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	defer f.Close()
}

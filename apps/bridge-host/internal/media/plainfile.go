package media

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// Connectors sometimes need a file rather than bytes: WhatsApp decrypts large media
// (over 5 MiB) into one. Those files hold plaintext, so they may only live in memory-backed
// storage (tmpfs), for as long as the connector needs them, and never on a disk.

// ErrNoMemoryStorage means no memory-backed directory is available for a plaintext file, so
// the media is refused rather than written to disk.
var ErrNoMemoryStorage = errors.New("media: no memory-backed storage for a plaintext file")

// PlainFileDirs are where plaintext files may go, in order of preference, if they are
// tmpfs. Tests override it.
var PlainFileDirs = []string{"/dev/shm"}

const tmpfsMagic = 0x01021994

// IsMemoryBacked reports whether dir is on tmpfs.
func IsMemoryBacked(dir string) bool {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return false
	}
	return int64(st.Type) == tmpfsMagic
}

// TempPlainFile creates an empty file for plaintext in memory-backed storage. The caller
// must remove it when done.
func TempPlainFile() (*os.File, error) {
	for _, dir := range PlainFileDirs {
		if IsMemoryBacked(dir) {
			return os.CreateTemp(dir, "trioditis-media-*")
		}
	}
	return nil, ErrNoMemoryStorage
}

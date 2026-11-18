package connector

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
)

// WhatsApp asks for a real file for large media and casts the writer to *os.File.
func TestUploadMediaStreamGivesAFileWhenRequired(t *testing.T) {
	if !media.IsMemoryBacked("/dev/shm") {
		t.Skip("/dev/shm isn't tmpfs here")
	}
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	in := &Intent{c: New(Options{Media: store})}
	var path string
	uri, _, err := in.UploadMediaStream(context.Background(), "", 6<<20, true, func(w io.Writer) (*bridgev2.FileStreamResult, error) {
		f, ok := w.(*os.File)
		if !ok {
			return nil, errors.New("not a file")
		}
		path = f.Name()
		_, err := f.Write([]byte("large media"))
		return &bridgev2.FileStreamResult{FileName: "video.mp4", MimeType: "video/mp4"}, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the plaintext file must be removed once read")
	}
	data, err := store.Read(uri)
	if err != nil || string(data) != "large media" {
		t.Fatalf("upload holds %q, %v", data, err)
	}
}

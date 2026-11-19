package networks

import (
	"os"
	"regexp"
	"testing"

	"go.mau.fi/mautrix-signal/pkg/libsignalgo/signalversion"
)

// The image builds the libsignal version mautrix-signal's bindings were generated against,
// so updating mautrix-signal without moving the pin fails here rather than at the image's
// link step. signalversion is plain Go, so this runs without libsignal.
func TestImageBuildsTheLibsignalMautrixSignalNeeds(t *testing.T) {
	dockerfile, err := os.ReadFile("../../../../deploy/docker/bridge-host.Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	pin := regexp.MustCompile(`(?m)^ARG LIBSIGNAL_VERSION=(\S+)$`).FindSubmatch(dockerfile)
	if pin == nil {
		t.Fatal("deploy/docker/bridge-host.Dockerfile has no LIBSIGNAL_VERSION")
	}
	if got := string(pin[1]); got != signalversion.Version {
		t.Fatalf("the image builds libsignal %s, but mautrix-signal needs %s: update LIBSIGNAL_VERSION and LIBSIGNAL_COMMIT (the tag's commit)", got, signalversion.Version)
	}
}

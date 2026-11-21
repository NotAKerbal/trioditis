// Trioditis: tests for the bridge host's patch (apps/bridge-host/third_party/README.md). Run
// from apps/bridge-host with libsignal on the linker path:
//
//	LIBRARY_PATH=<dir with libsignal_ffi.a> go test go.mau.fi/mautrix-signal/pkg/signalmeow

package signalmeow

import (
	"fmt"
	"testing"

	"github.com/google/uuid"
	"go.mau.fi/util/exsync"

	"go.mau.fi/mautrix-signal/pkg/libsignalgo"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/protobuf/signalpb"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/types"
)

// A group send is available to retry receipts only for the members Signal accepted it for:
// not for one whose send was uncertain, and not for anyone before Signal answered.
func TestTrioditisRetryCacheHoldsOnlyConfirmedSends(t *testing.T) {
	// Only the cache: NewClient needs a linked device's store.
	cli := &Client{sendCache: exsync.NewRingBuffer[sendCacheKey, *signalpb.Content](InMemorySendCacheSize)}
	sent, uncertain := libsignalgo.NewACIServiceID(uuid.New()), libsignalgo.NewACIServiceID(uuid.New())
	const group, ts = types.GroupIdentifier("group"), uint64(1234)
	content := &signalpb.Content{}
	cached := func(recipient libsignalgo.ServiceID) bool {
		_, ok := cli.sendCache.Get(sendCacheKey{recipient: recipient, groupID: group, timestamp: ts})
		return ok
	}

	// What SendGroupMessage does with a send that failed outright: no result, nothing cached.
	cli.cacheConfirmedSends(nil, group, ts, content)
	if cached(sent) || cached(uncertain) {
		t.Fatal("a send with no result was cached")
	}

	cli.cacheConfirmedSends(&GroupMessageSendResult{
		SuccessfullySentTo: []SuccessfulSendResult{{Recipient: sent}},
		FailedToSendTo:     []FailedSendResult{{Recipient: uncertain, Error: fmt.Errorf("%w (send returned 503)", ErrSendUncertain)}},
	}, group, ts, content)
	if !cached(sent) {
		t.Error("the member Signal accepted the send for can't get it again on a retry receipt")
	}
	if cached(uncertain) {
		t.Error("the member whose send was uncertain would get it again on a retry receipt")
	}
}

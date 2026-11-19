//go:build libsignal

package networks

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"go.mau.fi/mautrix-signal/pkg/signalmeow"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/protobuf/signalpb"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/web"
	"go.mau.fi/mautrix-signal/pkg/signalmeow/wspb"
)

// The patched signalmeow (third_party/mautrix-signal) reports a message send whose
// connection closed before Signal answered, instead of submitting it again on the next
// connection. A fake Signal answers the first send and drops the connection on the second.
func TestSignalSendIsNotResubmittedAfterADroppedConnection(t *testing.T) {
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		for {
			var msg signalpb.WebSocketMessage
			if err := wspb.Read(r.Context(), ws, &msg); err != nil {
				return
			}
			if msg.GetType() != signalpb.WebSocketMessage_REQUEST {
				continue
			}
			if sends.Add(1) > 1 {
				// The send went out; Signal's answer never comes back.
				return
			}
			typ, status := signalpb.WebSocketMessage_RESPONSE, uint32(200)
			if err := wspb.Write(r.Context(), ws, &signalpb.WebSocketMessage{
				Type:     &typ,
				Response: &signalpb.WebSocketResponseMessage{Id: msg.Request.Id, Status: &status},
			}); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	// signalmeow always dials chat.signal.org over TLS; this hands it the fake's plain
	// connection instead, which net/http then speaks HTTP/1.1 over.
	before := web.SignalHTTPClient
	web.SignalHTTPClient = &http.Client{Transport: &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", srv.Listener.Addr().String())
		},
	}}
	defer func() { web.SignalHTTPClient = before }()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ws := web.NewSignalWebsocket(nil)
	statuses := ws.Connect(ctx, nil)
	connected := make(chan struct{})
	go func() {
		for status := range statuses {
			if status.Event == web.SignalWebsocketConnectionEventConnected {
				select {
				case connected <- struct{}{}:
				default:
				}
			}
		}
	}()
	defer ws.Close()
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal("never connected to the fake Signal")
	}

	resp, err := ws.SendRequest(ctx, http.MethodPut, "/v1/messages/first", []byte(`{}`), nil)
	if err != nil || resp.GetStatus() != 200 {
		t.Fatalf("first send: got %v, %v; want the fake's 200", resp.GetStatus(), err)
	}
	// Upstream would wait here for the next connection (10 seconds on) and send it again.
	start := time.Now()
	_, err = ws.SendRequest(ctx, http.MethodPut, "/v1/messages/second", []byte(`{}`), nil)
	if !errors.Is(err, web.ErrRequestUncertain) || !errors.Is(err, signalmeow.ErrSendUncertain) {
		t.Fatalf("second send: got %v, want it reported uncertain", err)
	}
	if waited := time.Since(start); waited > 5*time.Second {
		t.Errorf("the uncertain send was reported after %v, so it waited for a reconnect", waited)
	}
	if n := sends.Load(); n != 2 {
		t.Errorf("the fake received %d sends, want 2", n)
	}
}

// A group send that failed for every member is reported as possibly delivered when it may
// have reached any of them, even if another member's refusal was certain.
func TestSignalGroupFailurePrefersTheUncertainOne(t *testing.T) {
	result := &signalmeow.GroupMessageSendResult{FailedToSendTo: []signalmeow.FailedSendResult{
		{Error: fmt.Errorf("%w (send returned 429)", signalmeow.ErrRateLimited)},
		{Error: fmt.Errorf("%w (send returned 503)", signalmeow.ErrSendUncertain)},
	}}
	if err := result.FailureError(); !errors.Is(err, signalmeow.ErrSendUncertain) {
		t.Fatalf("got %v, want the uncertain failure", err)
	}
}

//go:build libsignal

package networks

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
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

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ws := connectToFake(t, ctx, srv)
	defer ws.Close()

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

// Sends in flight when connections keep dropping each come back uncertain, those written to
// a connection that dropped as well as those that waited for the next, and none reaches
// Signal twice. (The patch also stops the write loop before answering the outstanding
// requests, so one registered meanwhile isn't left unanswered; that window is too narrow for
// this test to hit reliably.)
func TestSignalSendsAllComeBackWhenConnectionsDrop(t *testing.T) {
	var mu sync.Mutex
	received := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		// Each connection takes one request, answers nothing, and drops while the client is
		// still writing the others.
		var msg signalpb.WebSocketMessage
		if err := wspb.Read(r.Context(), ws, &msg); err != nil {
			return
		}
		mu.Lock()
		received[msg.GetRequest().GetPath()]++
		mu.Unlock()
	}))
	defer srv.Close()

	// Each reconnect waits 10 seconds, and a connection takes at least one send, so the
	// sends all come back within a few reconnects.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	ws := connectToFake(t, ctx, srv)
	defer ws.Close()

	const sends = 6
	errs := make(chan error, sends)
	for i := range sends {
		go func() {
			_, err := ws.SendRequest(ctx, http.MethodPut, fmt.Sprintf("/v1/messages/%d", i), []byte(`{}`), nil)
			errs <- err
		}()
	}
	for range sends {
		select {
		case err := <-errs:
			if !errors.Is(err, web.ErrRequestUncertain) {
				t.Errorf("a send came back with %v, want it uncertain", err)
			}
		case <-ctx.Done():
			t.Fatal("a send never came back")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for path, n := range received {
		if n > 1 {
			t.Errorf("%s reached the fake %d times", path, n)
		}
	}
}

// connectToFake connects a signalmeow websocket to srv, a fake Signal, and waits until it is
// connected.
func connectToFake(t *testing.T, ctx context.Context, srv *httptest.Server) *web.SignalWebsocket {
	t.Helper()
	// signalmeow always dials chat.signal.org over TLS; this hands it the fake's plain
	// connection instead, which net/http then speaks HTTP/1.1 over.
	before := web.SignalHTTPClient
	web.SignalHTTPClient = &http.Client{Transport: &http.Transport{
		DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", srv.Listener.Addr().String())
		},
	}}
	t.Cleanup(func() { web.SignalHTTPClient = before })

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
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal("never connected to the fake Signal")
	}
	return ws
}

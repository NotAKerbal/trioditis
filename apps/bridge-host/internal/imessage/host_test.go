package imessage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// fakeMac is a BlueBubbles Server, as much of it as the connector uses, with one direct chat.
type fakeMac struct {
	t        *testing.T
	srv      *httptest.Server
	password string
	chatGUID string

	lock    sync.Mutex
	texts   []map[string]any
	history []map[string]any
	frames  chan string
	// failText is a text the server answers with an unexpected error, after which whether
	// Messages sent it can't be known.
	failText string
	next     int
}

func newFakeMac(t *testing.T) *fakeMac {
	m := &fakeMac{t: t, password: "correct horse", chatGUID: "iMessage;-;+15550001111", frames: make(chan string, 64)}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *fakeMac) reply(w http.ResponseWriter, status int, data any) {
	body := map[string]any{"status": status, "message": "Success", "data": data}
	if status >= 300 {
		body = map[string]any{"status": status, "message": "Error", "error": data}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (m *fakeMac) message(guid, text string, fromMe bool, at int64) map[string]any {
	msg := map[string]any{
		"guid": guid, "text": text, "isFromMe": fromMe, "dateCreated": at, "itemType": 0, "error": 0,
		"chats": []any{map[string]any{"guid": m.chatGUID, "style": 45}},
	}
	if !fromMe {
		msg["handle"] = map[string]any{"address": "+15550001111", "service": "iMessage"}
	}
	return msg
}

func (m *fakeMac) push(event string, data any) {
	frame, _ := json.Marshal([]any{event, data})
	m.frames <- "42" + string(frame)
}

func (m *fakeMac) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("password") != m.password {
		m.reply(w, 401, map[string]string{"type": "Authentication Error", "message": "Unauthorized"})
		return
	}
	path := r.URL.Path
	chatPrefix := "/api/v1/chat/"
	switch {
	case path == "/socket.io/":
		m.socket(w, r)
	case path == "/api/v1/server/info":
		m.reply(w, 200, map[string]any{"computer_id": "MAC-1", "private_api": false, "helper_connected": false, "detected_imessage": "me@icloud.com"})
	case path == "/api/v1/chat/query":
		m.lock.Lock()
		last := m.history[len(m.history)-1]
		m.lock.Unlock()
		m.reply(w, 200, []any{map[string]any{
			"guid": m.chatGUID, "style": 45, "participants": []any{map[string]any{"address": "+15550001111"}}, "lastMessage": last,
		}})
	case path == "/api/v1/contact/query":
		m.reply(w, 200, []any{map[string]any{"displayName": "Ada Lovelace", "phoneNumbers": []any{map[string]any{"address": "+1 (555) 000-1111"}}}})
	case strings.HasPrefix(path, chatPrefix) && strings.HasSuffix(path, "/message"):
		m.lock.Lock()
		history := append([]map[string]any(nil), m.history...)
		m.lock.Unlock()
		// Newest first, as asked.
		for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
			history[i], history[j] = history[j], history[i]
		}
		m.reply(w, 200, history)
	case strings.HasPrefix(path, chatPrefix):
		// The server finds a chat by its "any" GUID too.
		guid := strings.TrimPrefix(path, chatPrefix)
		if guid != m.chatGUID && guid != "any;-;+15550001111" {
			m.reply(w, 404, map[string]string{"type": "Database Error", "message": "Chat does not exist!"})
			return
		}
		m.reply(w, 200, map[string]any{"guid": m.chatGUID, "style": 45, "participants": []any{map[string]any{"address": "+15550001111"}}})
	case path == "/api/v1/message/text":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.lock.Lock()
		m.texts = append(m.texts, body)
		m.next++
		guid := fmt.Sprintf("SENT-%d", m.next)
		fail := body["message"] == m.failText
		m.lock.Unlock()
		if body["chatGuid"] != m.chatGUID {
			m.t.Errorf("a send went to %v, not the chat's own GUID", body["chatGuid"])
		}
		if fail {
			m.reply(w, 500, map[string]string{"type": "Server Error", "message": "something broke"})
			return
		}
		sent := m.message(guid, body["message"].(string), true, time.Now().UnixMilli())
		// Messages' new row reaches the socket too, usually before the answer.
		m.push("new-message", sent)
		time.Sleep(50 * time.Millisecond)
		m.reply(w, 200, sent)
	default:
		m.reply(w, 404, map[string]string{"type": "Database Error", "message": "not here"})
	}
}

func (m *fakeMac) socket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := r.Context()
	_ = conn.Write(ctx, websocket.MessageText, []byte(`0{"sid":"s","pingInterval":60000,"pingTimeout":120000}`))
	if _, data, err := conn.Read(ctx); err != nil || string(data) != "40" {
		return
	}
	_ = conn.Write(ctx, websocket.MessageText, []byte(`40{"sid":"x"}`))
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-m.frames:
			if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
				return
			}
		}
	}
}

func (m *fakeMac) textsSent() []map[string]any {
	m.lock.Lock()
	defer m.lock.Unlock()
	return append([]map[string]any(nil), m.texts...)
}

type testHost struct {
	t    *testing.T
	h    *host.Host
	dir  string
	keys *devkeys.Keys
	key  seal.KeyPair
	from int64
}

func (th *testHost) events() []*protocol.Event {
	events, err := th.h.Store.After(context.Background(), 0, 10000)
	if err != nil {
		th.t.Fatal(err)
	}
	return events
}

func (th *testHost) waitFor(what string, match func(*protocol.Event) bool) *protocol.Event {
	th.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		for _, evt := range th.events() {
			if match(evt) {
				return evt
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	th.t.Fatalf("timed out waiting for %s", what)
	return nil
}

func (th *testHost) body(evt *protocol.Event) string {
	th.t.Helper()
	kp, err := th.keys.KeyPair(evt.UserID)
	if err != nil {
		th.t.Fatal(err)
	}
	var plain protocol.MessagePlaintext
	if err = seal.OpenJSON(evt.Sealed, kp, seal.Context{Kind: seal.KindMessage, OwnerUserID: evt.UserID, ObjectID: evt.EventID}, &plain); err != nil {
		th.t.Fatalf("%s doesn't open for its owner: %v", evt.EventID, err)
	}
	return plain.Body
}

func (th *testHost) command(cmd protocol.Command) {
	th.t.Helper()
	if err := th.h.Connector.HandleCommand(context.Background(), &cmd); err != nil {
		th.t.Fatalf("%s: %v", cmd.Type, err)
	}
}

func (th *testHost) sealed(userID, objectID string, value any) *seal.Envelope {
	th.t.Helper()
	env, err := seal.SealJSON(value, []seal.PublicKey{th.key.Public}, seal.Context{Kind: seal.KindOutbound, OwnerUserID: userID, ObjectID: objectID})
	if err != nil {
		th.t.Fatal(err)
	}
	return env
}

func startTestHost(t *testing.T, conn *Connector) *testHost {
	dir := t.TempDir()
	key, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	keys := &devkeys.Keys{Dir: filepath.Join(dir, "dev-keys")}
	h, err := host.New(host.Config{
		Network:          "imessage",
		DataDir:          dir,
		BridgeKey:        key,
		NetworkConnector: conn,
		KeyFetcher:       keys,
		SendTimeout:      20 * time.Second,
		AdjustBridgeConfig: func(cfg *bridgeconfig.BridgeConfig) {
			cfg.Backfill.Queue.Enabled = false
		},
		Log: zerolog.New(zerolog.NewTestWriter(t)).Level(zerolog.WarnLevel),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Stop)
	return &testHost{t: t, h: h, dir: dir, keys: keys, key: key}
}

// The connector against a fake Mac, through a real bridge host: signing in, catching up on
// recent history, a message arriving, a send, its echo, and a send whose outcome is unknown.
func TestIMessageThroughTheHost(t *testing.T) {
	mac := newFakeMac(t)
	mac.history = []map[string]any{mac.message("OLD-1", "from before signing in", false, time.Now().Add(-time.Hour).UnixMilli())}
	th := startTestHost(t, &Connector{allow: func(netip.Addr) bool { return true }})

	const user, session = "isaac", "imessage-session"
	th.command(protocol.Command{CommandID: "c-start", Type: protocol.CommandLoginStart, UserID: user, LoginSessionID: session, Network: "imessage", FlowID: FlowBlueBubbles})
	step := th.waitFor("the form", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepUserInput
	}).Step
	types := map[string]string{}
	for _, f := range step.Fields {
		types[f.ID] = f.Type
	}
	if types["url"] != "url" || types["password"] != "password" {
		t.Fatalf("login fields %v", types)
	}

	// A wrong password ends the login with an error, before anything is saved.
	th.command(protocol.Command{
		CommandID: "c-wrong", Type: protocol.CommandLoginSubmit, UserID: user, LoginSessionID: session, StepID: step.StepID,
		Sealed: th.sealed(user, session+"/"+step.StepID, protocol.LoginSubmitPlaintext{Input: map[string]string{"url": mac.srv.URL, "password": "nope"}}),
	})
	th.waitFor("the wrong password refused", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepError
	})

	session2 := session + "-2"
	th.command(protocol.Command{CommandID: "c-start-2", Type: protocol.CommandLoginStart, UserID: user, LoginSessionID: session2, Network: "imessage", FlowID: FlowBlueBubbles})
	step = th.waitFor("the form again", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session2 && e.Step.Type == protocol.StepUserInput
	}).Step
	// The address as people paste it: no scheme.
	address := strings.TrimPrefix(mac.srv.URL, "http://")
	th.command(protocol.Command{
		CommandID: "c-submit", Type: protocol.CommandLoginSubmit, UserID: user, LoginSessionID: session2, StepID: step.StepID,
		Sealed: th.sealed(user, session2+"/"+step.StepID, protocol.LoginSubmitPlaintext{Input: map[string]string{"url": address, "password": mac.password}}),
	})
	done := th.waitFor("signed in", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session2 && e.Step.Type == protocol.StepComplete
	})
	loginID := done.Step.LoginID

	// Catching up brings in the chat and its recent history.
	old := th.waitFor("history", func(e *protocol.Event) bool {
		return e.Type == protocol.EventMessage && e.LoginID == loginID && th.body(e) == "from before signing in"
	})
	portalID := old.PortalID

	mac.push("new-message", mac.message("NEW-1", "hello from the Mac", false, time.Now().UnixMilli()))
	incoming := th.waitFor("a new message", func(e *protocol.Event) bool {
		return e.Type == protocol.EventMessage && e.LoginID == loginID && th.body(e) == "hello from the Mac"
	})
	if incoming.PortalID != portalID || incoming.Sender == nil || incoming.Sender.Self {
		t.Fatalf("the message came in %+v", incoming)
	}

	send := func(clientMessageID, text string) {
		th.command(protocol.Command{
			CommandID: "c-" + clientMessageID, Type: protocol.CommandSend, UserID: user, LoginID: loginID, PortalID: portalID,
			ClientMessageID: clientMessageID, NotAfter: time.Now().Add(time.Hour).UnixMilli(),
			Sealed: th.sealed(user, clientMessageID, protocol.MessagePlaintext{Type: "text", Body: text}),
		})
	}
	statusOf := func(clientMessageID, status string) func(*protocol.Event) bool {
		return func(e *protocol.Event) bool {
			return e.Type == protocol.EventSendStatus && e.ClientMessageID == clientMessageID && e.Status == status
		}
	}

	send("cm-1", "hi from Trioditis")
	sent := th.waitFor("sent", statusOf("cm-1", protocol.StatusSent))
	if n := len(mac.textsSent()); n != 1 {
		t.Fatalf("the Mac was asked to send %d times", n)
	}
	// The Mac's echo of the same message isn't a second message.
	time.Sleep(500 * time.Millisecond)
	copies := 0
	for _, e := range th.events() {
		if e.Type == protocol.EventMessage && e.LoginID == loginID && th.body(e) == "hi from Trioditis" {
			copies++
			if e.EventID != sent.EventID {
				t.Errorf("the echo came in as its own message %s", e.EventID)
			}
		}
	}
	if copies != 1 {
		t.Errorf("%d copies of the sent message, want the one", copies)
	}

	// An error the server can't say more about may have sent it: unknown, and not sent again.
	mac.lock.Lock()
	mac.failText = "this one breaks"
	mac.lock.Unlock()
	send("cm-2", "this one breaks")
	th.waitFor("unknown", statusOf("cm-2", protocol.StatusUnknown))
	time.Sleep(300 * time.Millisecond)
	if n := len(mac.textsSent()); n != 2 {
		t.Errorf("the Mac was asked to send %d times in all, want 2", n)
	}

	th.h.Stop()
	// Nothing anyone wrote is kept readable on disk.
	err := filepath.Walk(th.dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, needle := range []string{"from before signing in", "hello from the Mac", "hi from Trioditis", "this one breaks"} {
			if bytes.Contains(data, []byte(needle)) {
				t.Errorf("%s holds %q", path, needle)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

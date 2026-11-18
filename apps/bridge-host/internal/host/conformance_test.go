package host

// The automated conformance suite: a real bridge host, running bridgev2 with the fake
// network connector, against a fake gateway. See docs/PLAN.md, Connector platform.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/connector"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/pkg/fakenet"
)

const testToken = "test-internal-token"

// fakeGateway implements the gateway side of the protocol, deduplicating like the real
// one should: by sequence number per host, then by event ID.
type fakeGateway struct {
	t    *testing.T
	srv  *httptest.Server
	keys map[string]seal.KeyPair

	lock        sync.Mutex
	nextSeq     int64
	events      []*protocol.Event
	received    int // event deliveries, including resends
	failNext    int
	ackShort    int // acknowledge this many fewer events than sent, once
	conflictSeq int64
	batches     []*protocol.EventBatch
	// invalid lists events the backend's validators would refuse.
	invalid []string
}

func newFakeGateway(t *testing.T, users ...string) *fakeGateway {
	g := &fakeGateway{t: t, keys: make(map[string]seal.KeyPair), nextSeq: 1}
	for _, user := range users {
		kp, err := seal.GenerateKeyPair()
		if err != nil {
			t.Fatal(err)
		}
		g.keys[user] = kp
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/events", g.handleEvents)
	mux.HandleFunc("GET /v1/keys/{userId}", g.handleKeys)
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGateway) handleKeys(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	kp, ok := g.keys[r.PathValue("userId")]
	if !ok {
		w.WriteHeader(http.StatusConflict)
		return
	}
	_ = json.NewEncoder(w).Encode(protocol.RecipientKeys{
		Identity:            protocol.RecipientKey{KID: kp.Public.KeyID(), PublicKey: kp.Public.String()},
		AgentGrantedPortals: []string{},
	})
}

func (g *fakeGateway) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var batch protocol.EventBatch
	if err := json.Unmarshal(raw, &batch); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var rawBatch struct {
		Events []map[string]json.RawMessage `json:"events"`
	}
	_ = json.Unmarshal(raw, &rawBatch)
	g.lock.Lock()
	defer g.lock.Unlock()
	for _, evt := range rawBatch.Events {
		if problem := validateEvent(evt); problem != "" {
			g.invalid = append(g.invalid, problem)
		}
	}
	g.batches = append(g.batches, &batch)
	g.received += len(batch.Events)
	if g.failNext > 0 {
		g.failNext--
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if g.conflictSeq > 0 {
		expected := g.conflictSeq
		g.conflictSeq = 0
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(protocol.EventBatchConflict{ExpectedSeq: expected})
		return
	}
	committed := g.nextSeq - 1
	limit := len(batch.Events)
	if g.ackShort > 0 && limit > g.ackShort {
		limit -= g.ackShort
		g.ackShort = 0
	}
	for _, evt := range batch.Events[:limit] {
		if evt.Seq < g.nextSeq {
			continue // a resend of something already committed
		} else if evt.Seq > g.nextSeq {
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(protocol.EventBatchConflict{ExpectedSeq: g.nextSeq})
			return
		}
		g.events = append(g.events, evt)
		g.nextSeq++
		committed = evt.Seq
	}
	_ = json.NewEncoder(w).Encode(protocol.EventBatchResponse{AckedThrough: committed})
}

// eventFields mirrors the backend's event validators (packages/backend/convex/validators.ts):
// for each event type, its required and optional fields beyond the ones every event has.
// The backend refuses an event with a missing or unknown field.
var eventFields = map[string][2][]string{
	protocol.EventMessage:        {{"portalId", "eventId", "networkTs", "sender", "sealed", "historical"}, {"replyTo", "threadRoot", "clientMessageId"}},
	protocol.EventEdit:           {{"portalId", "eventId", "targetEventId", "networkTs", "sender", "sealed"}, {"clientMessageId"}},
	protocol.EventReaction:       {{"portalId", "eventId", "targetEventId", "sender", "key", "networkTs"}, nil},
	protocol.EventReactionRemove: {{"portalId", "targetEventId", "sender", "key"}, nil},
	protocol.EventRedaction:      {{"portalId", "targetEventId", "sender", "networkTs"}, nil},
	protocol.EventReceipt:        {{"portalId", "sender", "upToEventId", "networkTs"}, nil},
	protocol.EventTyping:         {{"portalId", "sender", "typing", "timeoutMs"}, nil},
	protocol.EventChat:           {{"portalId", "kind", "sealed"}, {"parentPortalId", "deleted"}},
	protocol.EventContact:        {{"ghostId", "sealed"}, nil},
	protocol.EventLoginState:     {{"state"}, {"error"}},
	protocol.EventLoginStep:      {{"loginSessionId", "step"}, nil},
	protocol.EventSendStatus:     {{"clientMessageId", "status"}, {"eventId", "error"}},
	protocol.EventBackfillDone:   {{"portalId", "direction", "more"}, nil},
}

func validateEvent(evt map[string]json.RawMessage) string {
	var eventType string
	_ = json.Unmarshal(evt["type"], &eventType)
	fields, ok := eventFields[eventType]
	if !ok {
		return fmt.Sprintf("unknown event type %q", eventType)
	}
	allowed := map[string]bool{"seq": true, "type": true, "userId": true, "loginId": true, "at": true}
	for _, name := range []string{"seq", "type", "userId", "loginId", "at"} {
		if _, ok := evt[name]; !ok {
			return fmt.Sprintf("%s event is missing %s", eventType, name)
		}
	}
	for _, name := range fields[0] {
		allowed[name] = true
		if _, ok := evt[name]; !ok {
			return fmt.Sprintf("%s event is missing %s", eventType, name)
		}
	}
	for _, name := range fields[1] {
		allowed[name] = true
	}
	for name := range evt {
		if !allowed[name] {
			return fmt.Sprintf("%s event has unexpected field %s", eventType, name)
		}
	}
	return ""
}

func (g *fakeGateway) snapshot() []*protocol.Event {
	g.lock.Lock()
	defer g.lock.Unlock()
	return append([]*protocol.Event(nil), g.events...)
}

func (g *fakeGateway) waitFor(t *testing.T, what string, match func(*protocol.Event) bool) *protocol.Event {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, evt := range g.snapshot() {
			if match(evt) {
				return evt
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
	return nil
}

func (g *fakeGateway) count(match func(*protocol.Event) bool) int {
	n := 0
	for _, evt := range g.snapshot() {
		if match(evt) {
			n++
		}
	}
	return n
}

type harness struct {
	t         *testing.T
	dir       string
	gw        *fakeGateway
	net       *fakenet.Network
	host      *Host
	bridgeKey seal.KeyPair
}

var testBridgeKey = seal.SeedKeyPair([]byte("trioditis conformance bridge key"))

type hostOption func(*Config)

func withBridgeKey(kp seal.KeyPair) hostOption { return func(c *Config) { c.BridgeKey = kp } }

func withDatabase(dbType, uri string) hostOption {
	return func(c *Config) { c.DatabaseType, c.DatabaseURI = dbType, uri }
}

func startHost(t *testing.T, dir string, gw *fakeGateway, opts ...hostOption) *harness {
	t.Helper()
	h := buildHost(t, dir, gw, opts...)
	if err := h.host.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	return h
}

// buildHost makes a host without starting it, so a test can prepare its database first.
func buildHost(t *testing.T, dir string, gw *fakeGateway, opts ...hostOption) *harness {
	t.Helper()
	net := fakenet.New()
	cfg := Config{
		Network:          "fake",
		DataDir:          dir,
		ListenAddr:       "127.0.0.1:0",
		CommandAddr:      "http://127.0.0.1:0",
		GatewayURL:       gw.srv.URL,
		InternalToken:    testToken,
		BridgeKey:        testBridgeKey,
		NetworkConnector: net,
		SendTimeout:      5 * time.Second,
		AdjustBridgeConfig: func(cfg *bridgeconfig.BridgeConfig) {
			cfg.Backfill.Queue.Enabled = false
		},
		Log: zerolog.New(zerolog.NewTestWriter(t)).Level(testLogLevel),
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, dir: dir, gw: gw, net: net, host: h, bridgeKey: cfg.BridgeKey}
}

func (h *harness) command(cmd protocol.Command) (int, string) {
	h.t.Helper()
	body, _ := json.Marshal(cmd)
	req, _ := http.NewRequest(http.MethodPost, "http://"+h.host.Addr()+"/v1/commands", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

func (h *harness) mustCommand(cmd protocol.Command) {
	h.t.Helper()
	if status, body := h.command(cmd); status != http.StatusAccepted {
		h.t.Fatalf("%s returned %d: %s", cmd.Type, status, body)
	}
}

func (h *harness) sealForBridge(userID, objectID string, value any) *seal.Envelope {
	h.t.Helper()
	env, err := seal.SealJSON(value, []seal.PublicKey{h.bridgeKey.Public}, seal.Context{Kind: seal.KindOutbound, OwnerUserID: userID, ObjectID: objectID})
	if err != nil {
		h.t.Fatal(err)
	}
	return env
}

var commandCounter int

func nextCommandID() string {
	commandCounter++
	return fmt.Sprintf("cmd-%d-%d", time.Now().UnixNano(), commandCounter)
}

// login runs the fake network's login flow through commands and returns the opaque login ID.
func (h *harness) login(userID, username string) string {
	h.t.Helper()
	session := "session-" + username
	h.mustCommand(protocol.Command{CommandID: nextCommandID(), Type: protocol.CommandLoginStart, UserID: userID, LoginSessionID: session, Network: "fake"})
	step := h.gw.waitFor(h.t, "username step", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepUserInput
	}).Step
	if len(step.Fields) != 1 || step.Fields[0].ID != "username" {
		h.t.Fatalf("unexpected login fields: %+v", step.Fields)
	}
	h.mustCommand(protocol.Command{
		CommandID: nextCommandID(), Type: protocol.CommandLoginSubmit, UserID: userID, LoginSessionID: session, StepID: step.StepID,
		Sealed: h.sealForBridge(userID, session+"/"+step.StepID, protocol.LoginSubmitPlaintext{Input: map[string]string{"username": username}}),
	})
	complete := h.gw.waitFor(h.t, "login complete", func(e *protocol.Event) bool {
		return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepComplete
	})
	if complete.Step.LoginID == "" || strings.Contains(complete.Step.LoginID, username) {
		h.t.Fatalf("login ID must be opaque, got %q", complete.Step.LoginID)
	}
	return complete.Step.LoginID
}

func (h *harness) open(userID string, evt *protocol.Event, out any) {
	h.t.Helper()
	ctx := seal.Context{OwnerUserID: userID}
	switch evt.Type {
	case protocol.EventMessage, protocol.EventEdit:
		ctx.Kind, ctx.ObjectID = seal.KindMessage, evt.EventID
	case protocol.EventChat:
		ctx.Kind, ctx.ObjectID = seal.KindChat, evt.PortalID
	case protocol.EventContact:
		ctx.Kind, ctx.ObjectID = seal.KindContact, evt.GhostID
	default:
		h.t.Fatalf("%s isn't sealed", evt.Type)
	}
	if err := seal.OpenJSON(evt.Sealed, h.gw.keys[userID], ctx, out); err != nil {
		h.t.Fatalf("%s %s doesn't open for its owner: %v", evt.Type, evt.EventID, err)
	}
}

func isMessage(body string, h *harness, userID string) func(*protocol.Event) bool {
	return func(e *protocol.Event) bool {
		if e.Type != protocol.EventMessage || e.UserID != userID {
			return false
		}
		var plain protocol.MessagePlaintext
		h.open(userID, e, &plain)
		return plain.Body == body
	}
}

func TestConformance(t *testing.T) {
	dir := t.TempDir()
	gw := newFakeGateway(t, "alice", "bob")
	h := startHost(t, dir, gw)
	aliceLogin := h.login("alice", "alice-fake")
	const aliceNet = networkid.UserLoginID("alice-fake")

	t.Run("registers with an empty batch on startup", func(t *testing.T) {
		gw.lock.Lock()
		defer gw.lock.Unlock()
		if len(gw.batches) == 0 || len(gw.batches[0].Events) != 0 || gw.batches[0].HostID != "fake-1" {
			t.Fatalf("the first batch must be an empty heartbeat from fake-1, got %+v", gw.batches[0])
		}
	})

	t.Run("refuses a login for someone with no key, with a code", func(t *testing.T) {
		status, body := h.command(protocol.Command{CommandID: nextCommandID(), Type: protocol.CommandLoginStart, UserID: "nokey", LoginSessionID: "s-nokey"})
		if status != http.StatusConflict || strings.TrimSpace(body) != `{"error":"invalid_command"}` {
			t.Fatalf("expected 409 invalid_command, got %d %s", status, body)
		}
	})

	// History the chat already has before Trioditis sees it. bridgev2 imports it through
	// BatchSend when the chat's portal is created.
	base := time.Now().Add(-time.Hour)
	h.net.SetHistory("family", []fakenet.HistoryMessage{
		{ID: "h1", SenderID: "peer-family", Text: "history one", TS: base},
		{ID: "h2", SenderID: networkid.UserID(aliceNet), Text: "history two", TS: base.Add(time.Minute)},
	})

	if err := h.net.Incoming(aliceNet, "family", "peer-family", "m1", "secret-plaintext-hello", time.Now()); err != nil {
		t.Fatal(err)
	}
	first := gw.waitFor(t, "incoming message", isMessage("secret-plaintext-hello", h, "alice"))
	portalID := first.PortalID

	t.Run("incoming message is sealed to its owner only", func(t *testing.T) {
		if first.Sender == nil || first.Sender.Self || first.Sender.GhostID == "" {
			t.Fatalf("expected a ghost sender, got %+v", first.Sender)
		}
		if first.Historical == nil || *first.Historical {
			t.Fatal("a live message must not be historical")
		}
		if strings.Contains(portalID, "family") || strings.Contains(first.Sender.GhostID, "peer") {
			t.Fatal("portal and ghost IDs must be opaque")
		}
		var plain protocol.MessagePlaintext
		if err := seal.OpenJSON(first.Sealed, gw.keys["bob"], seal.Context{Kind: seal.KindMessage, OwnerUserID: "alice", ObjectID: first.EventID}, &plain); err == nil {
			t.Fatal("bob opened alice's message")
		}
	})

	t.Run("chat and contact metadata are sealed", func(t *testing.T) {
		chat := gw.waitFor(t, "chat event", func(e *protocol.Event) bool { return e.Type == protocol.EventChat && e.PortalID == portalID })
		var chatPlain protocol.ChatPlaintext
		h.open("alice", chat, &chatPlain)
		if chatPlain.Name != "Chat family" {
			t.Fatalf("chat name %q", chatPlain.Name)
		}
		contact := gw.waitFor(t, "contact event", func(e *protocol.Event) bool {
			return e.Type == protocol.EventContact && e.GhostID == first.Sender.GhostID && e.UserID == "alice"
		})
		var contactPlain protocol.ContactPlaintext
		h.open("alice", contact, &contactPlain)
		if contactPlain.Name != "Fake peer-family" {
			t.Fatalf("contact name %q", contactPlain.Name)
		}
		// Chat and contact names never appear in the journal. (bridgev2's own portal and
		// ghost tables do hold them; see the README's spike findings.)
		journal, err := h.host.Store.After(context.Background(), 0, 100000)
		if err != nil {
			t.Fatal(err)
		}
		for _, evt := range journal {
			raw, _ := json.Marshal(evt)
			if bytes.Contains(raw, []byte("Chat family")) || bytes.Contains(raw, []byte("Fake peer-family")) {
				t.Fatalf("journal event %d holds a plaintext name", evt.Seq)
			}
		}
	})

	t.Run("history arrives through BatchSend, flagged historical", func(t *testing.T) {
		for _, body := range []string{"history one", "history two"} {
			evt := gw.waitFor(t, body, isMessage(body, h, "alice"))
			if evt.Historical == nil || !*evt.Historical {
				t.Fatalf("%q must be historical", body)
			}
			if body == "history two" && (evt.Sender == nil || !evt.Sender.Self) {
				t.Fatalf("alice's own history must be attributed to her, got %+v", evt.Sender)
			}
		}
	})

	t.Run("a message sent from the phone is attributed to the person", func(t *testing.T) {
		if err := h.net.Incoming(aliceNet, "family", networkid.UserID(aliceNet), "m2", "from my phone", time.Now()); err != nil {
			t.Fatal(err)
		}
		evt := gw.waitFor(t, "self message", isMessage("from my phone", h, "alice"))
		if evt.Sender == nil || !evt.Sender.Self {
			t.Fatalf("expected {self:true}, got %+v", evt.Sender)
		}
	})

	t.Run("a network resend of the same message is bridged once", func(t *testing.T) {
		_ = h.net.Incoming(aliceNet, "family", "peer-family", "m1", "secret-plaintext-hello", time.Now())
		time.Sleep(300 * time.Millisecond)
		if n := gw.count(isMessage("secret-plaintext-hello", h, "alice")); n != 1 {
			t.Fatalf("message bridged %d times", n)
		}
	})

	t.Run("edits, reactions, redactions, receipts and typing", func(t *testing.T) {
		if err := h.net.Edit(aliceNet, "family", "peer-family", "m1", "edited hello"); err != nil {
			t.Fatal(err)
		}
		edit := gw.waitFor(t, "edit", func(e *protocol.Event) bool { return e.Type == protocol.EventEdit && e.TargetEventID == first.EventID })
		var editPlain protocol.MessagePlaintext
		h.open("alice", edit, &editPlain)
		if editPlain.Body != "edited hello" {
			t.Fatalf("edit body %q", editPlain.Body)
		}
		if err := h.net.React(aliceNet, "family", "peer-family", "m1", "👍", false); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "reaction", func(e *protocol.Event) bool {
			return e.Type == protocol.EventReaction && e.TargetEventID == first.EventID && e.Key == "👍"
		})
		if err := h.net.React(aliceNet, "family", "peer-family", "m1", "👍", true); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "reaction removal", func(e *protocol.Event) bool {
			return e.Type == protocol.EventReactionRemove && e.TargetEventID == first.EventID && e.Key == "👍"
		})
		if err := h.net.Receipt(aliceNet, "family", "peer-family", "m1"); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "receipt", func(e *protocol.Event) bool { return e.Type == protocol.EventReceipt && e.UpToEventID == first.EventID })
		if err := h.net.Typing(aliceNet, "family", "peer-family", 5*time.Second); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "typing", func(e *protocol.Event) bool { return e.Type == protocol.EventTyping && e.Typing != nil && *e.Typing })
		if err := h.net.Remove(aliceNet, "family", "peer-family", "m1"); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "redaction", func(e *protocol.Event) bool {
			return e.Type == protocol.EventRedaction && e.TargetEventID == first.EventID
		})
	})

	sendCommand := func(clientMessageID, body string) protocol.Command {
		return protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: clientMessageID, NotAfter: time.Now().Add(time.Hour).UnixMilli(),
			Sealed: h.sealForBridge("alice", clientMessageID, protocol.MessagePlaintext{Type: "text", Body: body}),
		}
	}
	send := func(clientMessageID, body string) {
		t.Helper()
		h.mustCommand(sendCommand(clientMessageID, body))
	}
	statusOf := func(clientMessageID, status string) func(*protocol.Event) bool {
		return func(e *protocol.Event) bool {
			return e.Type == protocol.EventSendStatus && e.ClientMessageID == clientMessageID && e.Status == status
		}
	}

	t.Run("send: submitted, sent, then the person's sealed copy", func(t *testing.T) {
		send("cm-ok", "sent from trioditis")
		gw.waitFor(t, "submitted", statusOf("cm-ok", protocol.StatusSubmitted))
		sent := gw.waitFor(t, "sent", statusOf("cm-ok", protocol.StatusSent))
		copyEvt := gw.waitFor(t, "own copy", func(e *protocol.Event) bool { return e.Type == protocol.EventMessage && e.ClientMessageID == "cm-ok" })
		if copyEvt.EventID != sent.EventID || !copyEvt.Sender.Self {
			t.Fatalf("own copy %+v doesn't match sent status %+v", copyEvt, sent)
		}
		var plain protocol.MessagePlaintext
		h.open("alice", copyEvt, &plain)
		if plain.Body != "sent from trioditis" {
			t.Fatalf("own copy body %q", plain.Body)
		}
	})

	t.Run("a repeated send isn't sent again", func(t *testing.T) {
		before := len(h.net.Sent())
		send("cm-ok", "sent from trioditis")
		time.Sleep(300 * time.Millisecond)
		if after := len(h.net.Sent()); after != before {
			t.Fatalf("repeated clientMessageId reached the network again (%d → %d)", before, after)
		}
		if n := gw.count(statusOf("cm-ok", protocol.StatusSent)); n != 2 {
			t.Fatalf("expected the last status to be repeated once, saw %d sent statuses", n)
		}
	})

	t.Run("an ambiguous send becomes unknown and isn't retried", func(t *testing.T) {
		h.net.SetSendMode(fakenet.SendAmbiguous)
		defer h.net.SetSendMode(fakenet.SendOK)
		before := len(h.net.Sent())
		send("cm-ambiguous", "maybe sent")
		unknown := gw.waitFor(t, "unknown", statusOf("cm-ambiguous", protocol.StatusUnknown))
		if unknown.Error != protocol.ErrInternal {
			t.Fatalf("expected error code internal, got %q", unknown.Error)
		}
		time.Sleep(300 * time.Millisecond)
		if gw.count(statusOf("cm-ambiguous", protocol.StatusSent)) != 0 || len(h.net.Sent()) != before {
			t.Fatal("an ambiguous send was retried")
		}
	})

	t.Run("a refused send fails", func(t *testing.T) {
		h.net.SetSendMode(fakenet.SendRefused)
		defer h.net.SetSendMode(fakenet.SendOK)
		send("cm-refused", "refused")
		failed := gw.waitFor(t, "failed", statusOf("cm-refused", protocol.StatusFailed))
		if failed.Error != protocol.ErrNetworkRejected {
			t.Fatalf("expected error code network_rejected, got %q", failed.Error)
		}
	})

	t.Run("a send past notAfter expires without reaching the network", func(t *testing.T) {
		before := len(h.net.Sent())
		h.mustCommand(protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: "cm-expired", NotAfter: time.Now().Add(-time.Second).UnixMilli(),
			Sealed: h.sealForBridge("alice", "cm-expired", protocol.MessagePlaintext{Type: "text", Body: "too late"}),
		})
		expired := gw.waitFor(t, "expired", statusOf("cm-expired", protocol.StatusFailed))
		if expired.Error != protocol.ErrExpired || len(h.net.Sent()) != before {
			t.Fatalf("expected an expired failure with nothing sent, got %q", expired.Error)
		}
	})

	t.Run("a send without a deadline is refused", func(t *testing.T) {
		cmd := sendCommand("cm-nodeadline", "x")
		cmd.NotAfter = 0
		if status, _ := h.command(cmd); status != http.StatusBadRequest {
			t.Fatalf("expected 400 for a send without notAfter, got %d", status)
		}
	})

	t.Run("a reply to a message in another chat is refused", func(t *testing.T) {
		if err := h.net.Incoming(aliceNet, "other-chat", "peer-other", "o1", "in another chat", time.Now()); err != nil {
			t.Fatal(err)
		}
		other := gw.waitFor(t, "other chat's message", isMessage("in another chat", h, "alice"))
		cmd := sendCommand("cm-crossreply", "reply")
		cmd.ReplyTo = other.EventID
		if status, _ := h.command(cmd); status != http.StatusConflict {
			t.Fatalf("expected 409 for a reply into another chat, got %d", status)
		}
		cmd = sendCommand("cm-reply", "reply")
		cmd.ReplyTo = gw.waitFor(t, "a message in this chat", isMessage("from my phone", h, "alice")).EventID
		h.mustCommand(cmd)
		gw.waitFor(t, "reply sent", statusOf("cm-reply", protocol.StatusSent))
	})

	t.Run("sends in a chat go one at a time, and a deadline is checked at hand-off", func(t *testing.T) {
		h.net.SetSendDelay(time.Second)
		before := len(h.net.Sent())
		send("cm-slow", "slow one")
		late := sendCommand("cm-late", "waits behind the slow one")
		// In time when it arrives, too late by the time the slow send lets it go.
		late.NotAfter = time.Now().Add(connector.HandoffMargin + 300*time.Millisecond).UnixMilli()
		h.mustCommand(late)
		gw.waitFor(t, "slow send", statusOf("cm-slow", protocol.StatusSent))
		h.net.SetSendDelay(0)
		expired := gw.waitFor(t, "late send expired", statusOf("cm-late", protocol.StatusFailed))
		if expired.Error != protocol.ErrExpired || len(h.net.Sent()) != before+1 {
			t.Fatalf("the send behind must expire unsent, got %q with %d sent", expired.Error, len(h.net.Sent())-before)
		}
	})

	t.Run("an outcome after a timeout is still reported", func(t *testing.T) {
		h.host.Connector.SendTimeout = 200 * time.Millisecond
		h.net.SetSendDelay(800 * time.Millisecond)
		send("cm-latecomer", "slow network")
		gw.waitFor(t, "unknown after the timeout", statusOf("cm-latecomer", protocol.StatusUnknown))
		gw.waitFor(t, "sent once the network answers", statusOf("cm-latecomer", protocol.StatusSent))
		gw.waitFor(t, "own copy", func(e *protocol.Event) bool {
			return e.Type == protocol.EventMessage && e.ClientMessageID == "cm-latecomer"
		})
		h.net.SetSendDelay(0)
		h.host.Connector.SendTimeout = 5 * time.Second
	})

	t.Run("a send waiting behind a slow incoming event isn't marked unknown before it starts", func(t *testing.T) {
		h.host.Connector.SendTimeout = 200 * time.Millisecond
		h.net.SetIncomingDelay(450 * time.Millisecond)
		go func() {
			_ = h.net.Incoming(aliceNet, "family", "peer-family", "slow-incoming", "a big file", time.Now())
		}()
		time.Sleep(50 * time.Millisecond)
		send("cm-behind", "waits for the chat")
		gw.waitFor(t, "sent once the chat is free", statusOf("cm-behind", protocol.StatusSent))
		if n := gw.count(statusOf("cm-behind", protocol.StatusUnknown)); n != 0 {
			t.Fatalf("a send still waiting to start was marked unknown")
		}
		h.net.SetIncomingDelay(0)
		h.host.Connector.SendTimeout = 5 * time.Second
	})

	t.Run("a send still running after bridgev2 stops waiting holds its chat", func(t *testing.T) {
		// bridgev2 normally gives up waiting after five minutes; with no ticks it gives up at
		// once, and the send carries on in the background.
		ticks := bridgev2.EventHandlingTimeoutTicks
		bridgev2.EventHandlingTimeoutTicks = 0
		defer func() { bridgev2.EventHandlingTimeoutTicks = ticks }()
		h.host.Connector.SendTimeout = 100 * time.Millisecond
		defer func() { h.host.Connector.SendTimeout = 5 * time.Second }()
		before := len(h.net.Sent())
		h.net.SetSendDelay(1500 * time.Millisecond)
		send("cm-background", "still sending")
		send("cm-after-background", "must wait for it")
		// Marked unknown once it has been stuck long enough, while still running...
		gw.waitFor(t, "unknown while still running", statusOf("cm-background", protocol.StatusUnknown))
		h.net.SetSendDelay(0)
		time.Sleep(300 * time.Millisecond)
		// ...but the chat's next send hasn't started alongside it.
		if n := len(h.net.Sent()) - before; n != 0 {
			t.Fatalf("%d sends reached the network while the first was still being handled", n)
		}
		gw.waitFor(t, "the first finishes", statusOf("cm-background", protocol.StatusSent))
		gw.waitFor(t, "then the next goes", statusOf("cm-after-background", protocol.StatusSent))
		if sent := h.net.Sent(); len(sent)-before != 2 || sent[before].Body != "still sending" {
			t.Fatalf("expected both sends in order, got %d", len(sent)-before)
		}
	})

	t.Run("an outcome reported with a cancelled context is still recorded", func(t *testing.T) {
		h.net.SetSendDelay(800 * time.Millisecond)
		defer h.net.SetSendDelay(0)
		send("cm-cancelled-ctx", "its chat goes away")
		gw.waitFor(t, "submitted", statusOf("cm-cancelled-ctx", protocol.StatusSubmitted))
		// As bridgev2 does when the chat is deleted while the send is out: the context it
		// reports the outcome with is already cancelled.
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		h.host.Connector.SendMessageStatus(ctx, &bridgev2.MessageStatus{Status: event.MessageStatusSuccess}, &bridgev2.MessageStatusEventInfo{
			SourceEventID: ids.OutgoingEventID("alice", "cm-cancelled-ctx"),
		})
		gw.waitFor(t, "sent, recorded despite the cancelled context", statusOf("cm-cancelled-ctx", protocol.StatusSent))
	})

	t.Run("a login step takes one submit", func(t *testing.T) {
		session := "session-twice"
		h.mustCommand(protocol.Command{CommandID: nextCommandID(), Type: protocol.CommandLoginStart, UserID: "alice", LoginSessionID: session, Network: "fake"})
		step := gw.waitFor(t, "username step", func(e *protocol.Event) bool {
			return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepUserInput
		}).Step
		submit := func() int {
			status, _ := h.command(protocol.Command{
				CommandID: nextCommandID(), Type: protocol.CommandLoginSubmit, UserID: "alice", LoginSessionID: session, StepID: step.StepID,
				Sealed: h.sealForBridge("alice", session+"/"+step.StepID, protocol.LoginSubmitPlaintext{Input: map[string]string{"username": "alice-second"}}),
			})
			return status
		}
		first, second := submit(), submit()
		if first != http.StatusAccepted || (second != http.StatusAccepted && second != http.StatusConflict) {
			t.Fatalf("submits answered %d then %d", first, second)
		}
		gw.waitFor(t, "login complete", func(e *protocol.Event) bool {
			return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type == protocol.StepComplete
		})
		time.Sleep(300 * time.Millisecond)
		if n := gw.count(func(e *protocol.Event) bool {
			return e.Type == protocol.EventLoginStep && e.LoginSessionID == session && e.Step.Type != protocol.StepUserInput
		}); n != 1 {
			t.Fatalf("a second submit changed the login: %d further steps", n)
		}
	})

	t.Run("every error is a code and every event is well-formed", func(t *testing.T) {
		gw.lock.Lock()
		invalid := append([]string(nil), gw.invalid...)
		gw.lock.Unlock()
		if len(invalid) > 0 {
			t.Fatalf("events the backend would refuse: %v", invalid)
		}
		codes := map[string]bool{
			protocol.ErrNetworkRejected: true, protocol.ErrNotConnected: true, protocol.ErrTimeout: true,
			protocol.ErrInvalidCommand: true, protocol.ErrExpired: true, protocol.ErrUnsupported: true,
			protocol.ErrRateLimited: true, protocol.ErrBadCredentials: true, protocol.ErrLoginFailed: true, protocol.ErrInternal: true,
		}
		for _, evt := range gw.snapshot() {
			raw, _ := json.Marshal(evt)
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			_, hasUser := fields["userId"]
			_, hasLogin := fields["loginId"]
			if evt.Seq < 1 || evt.Type == "" || !hasUser || !hasLogin || evt.UserID == "" {
				t.Fatalf("malformed event %s", raw)
			}
			if evt.Error != "" && !codes[evt.Error] {
				t.Fatalf("event %d has a non-code error %q", evt.Seq, evt.Error)
			}
			if evt.Step != nil && evt.Step.Error != "" && !codes[evt.Step.Error] {
				t.Fatalf("login step has a non-code error %q", evt.Step.Error)
			}
		}
	})

	t.Run("commands are idempotent by command ID", func(t *testing.T) {
		cmd := protocol.Command{
			CommandID: "fixed-command-id", Type: protocol.CommandSend, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: "cm-idem", NotAfter: time.Now().Add(time.Hour).UnixMilli(), Sealed: h.sealForBridge("alice", "cm-idem", protocol.MessagePlaintext{Type: "text", Body: "once"}),
		}
		h.mustCommand(cmd)
		h.mustCommand(cmd)
		gw.waitFor(t, "sent", statusOf("cm-idem", protocol.StatusSent))
		time.Sleep(200 * time.Millisecond)
		if n := gw.count(statusOf("cm-idem", protocol.StatusSubmitted)); n != 1 {
			t.Fatalf("command ran %d times", n)
		}
	})

	t.Run("people can only use their own logins", func(t *testing.T) {
		status, _ := h.command(protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "bob", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: "cm-bob", NotAfter: time.Now().Add(time.Hour).UnixMilli(), Sealed: h.sealForBridge("bob", "cm-bob", protocol.MessagePlaintext{Type: "text", Body: "x"}),
		})
		if status != http.StatusConflict {
			t.Fatalf("expected 409 for someone else's login, got %d", status)
		}
		status, body := h.command(protocol.Command{CommandID: nextCommandID(), Type: "nonsense", UserID: "alice"})
		if status != http.StatusBadRequest || strings.TrimSpace(body) != `{"error":"invalid_command"}` {
			t.Fatalf("expected 400 invalid_command, got %d %s", status, body)
		}
	})

	t.Run("two people in the same chat each get their own copy", func(t *testing.T) {
		bobLogin := h.login("bob", "bob-fake")
		if err := h.net.Incoming("bob-fake", "family", "peer-family", "b1", "hello bob", time.Now()); err != nil {
			t.Fatal(err)
		}
		evt := gw.waitFor(t, "bob's message", isMessage("hello bob", h, "bob"))
		if evt.PortalID == portalID || evt.LoginID != bobLogin {
			t.Fatal("bob's copy of the chat must be a separate portal on his own login")
		}
	})

	t.Run("attachments are sealed and their bytes never stored in plaintext", func(t *testing.T) {
		image := []byte("secret-plaintext-image-bytes")
		if err := h.net.IncomingImage(aliceNet, "family", "peer-family", "img1", image, time.Now()); err != nil {
			t.Fatal(err)
		}
		evt := gw.waitFor(t, "image", func(e *protocol.Event) bool {
			if e.Type != protocol.EventMessage || e.UserID != "alice" {
				return false
			}
			var plain protocol.MessagePlaintext
			h.open("alice", e, &plain)
			return plain.Type == "image"
		})
		var plain protocol.MessagePlaintext
		h.open("alice", evt, &plain)
		if len(plain.Attachments) != 1 {
			t.Fatalf("expected one attachment, got %+v", plain.Attachments)
		}
		att := plain.Attachments[0]
		ct, err := os.ReadFile(filepath.Join(dir, "media", "fake", att.MediaID))
		if err != nil {
			t.Fatal(err)
		}
		got, err := seal.DecryptMedia(ct, att.Key, att.Nonce, "alice", att.MediaID)
		if err != nil || !bytes.Equal(got, image) {
			t.Fatalf("attachment doesn't decrypt to the image: %v", err)
		}
	})

	t.Run("an outbound attachment is read through the media store", func(t *testing.T) {
		data := []byte("outbound file")
		enc, err := seal.EncryptMedia(data, "alice", "outmedia1")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "media", "fake", "outmedia1"), enc.Ciphertext, 0o600); err != nil {
			t.Fatal(err)
		}
		h.mustCommand(protocol.Command{
			CommandID: nextCommandID(), Type: protocol.CommandSend, UserID: "alice", LoginID: aliceLogin, PortalID: portalID,
			ClientMessageID: "cm-file", NotAfter: time.Now().Add(time.Hour).UnixMilli(), Sealed: h.sealForBridge("alice", "cm-file", protocol.MessagePlaintext{
				Type: "file", Body: "notes.txt",
				Attachments: []protocol.Attachment{{MediaID: "outmedia1", Mime: "text/plain", Size: len(data), Name: "notes.txt", Key: enc.Key, Nonce: enc.Nonce}},
			}),
		})
		gw.waitFor(t, "sent", statusOf("cm-file", protocol.StatusSent))
	})

	t.Run("journal resends after partial acks, failures and conflicts", func(t *testing.T) {
		gw.lock.Lock()
		gw.ackShort, gw.failNext = 1, 2
		gw.lock.Unlock()
		for i := range 5 {
			if err := h.net.Incoming(aliceNet, "family", "peer-family", networkid.MessageID(fmt.Sprintf("burst-%d", i)), fmt.Sprintf("burst %d", i), time.Now()); err != nil {
				t.Fatal(err)
			}
		}
		gw.waitFor(t, "last burst message", isMessage("burst 4", h, "alice"))
		gw.lock.Lock()
		gw.conflictSeq = 3
		gw.lock.Unlock()
		if err := h.net.Incoming(aliceNet, "family", "peer-family", "after-conflict", "after conflict", time.Now()); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "message after a conflict", isMessage("after conflict", h, "alice"))
	})

	t.Run("journal is ordered and gap-free", func(t *testing.T) {
		checkOrdered(t, gw.snapshot())
	})

	t.Run("exactly once across a restart", func(t *testing.T) {
		h.net.SetSendMode(fakenet.SendOK)
		// A send whose outcome is never reported, then a restart: it must become unknown.
		h.host.Connector.SendTimeout = time.Hour
		gw.lock.Lock()
		gw.failNext = 1 << 30 // the gateway is down while the host stops
		gw.lock.Unlock()
		if err := h.net.Incoming(aliceNet, "family", "peer-family", "before-restart", "before restart", time.Now()); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
		// Then a send the network never answers: it holds the chat until the host stops.
		h.net.SetSendDelay(time.Hour)
		sentBefore := len(h.net.Sent())
		send("cm-inflight", "in flight at the restart")
		deadline := time.Now().Add(5 * time.Second)
		for {
			if out, err := h.host.Store.GetOutgoing(context.Background(), "alice", "cm-inflight"); err == nil && out.Status == protocol.StatusSubmitted {
				break
			} else if time.Now().After(deadline) {
				t.Fatal("the in-flight send was never handed off")
			}
			time.Sleep(20 * time.Millisecond)
		}
		h.host.Stop()

		gw.lock.Lock()
		gw.failNext = 0
		gw.lock.Unlock()
		h2 := startHost(t, dir, gw)
		defer h2.host.Stop()
		gw.waitFor(t, "message journaled before the restart", isMessage("before restart", h2, "alice"))
		if err := h2.net.Incoming(aliceNet, "family", "peer-family", "after-restart", "after restart", time.Now()); err != nil {
			t.Fatal(err)
		}
		gw.waitFor(t, "message after the restart", isMessage("after restart", h2, "alice"))
		inflight := gw.waitFor(t, "in-flight send unknown", statusOf("cm-inflight", protocol.StatusUnknown))
		if inflight.Error == "" || gw.count(statusOf("cm-inflight", protocol.StatusSent)) != 0 || len(h.net.Sent()) != sentBefore {
			t.Fatalf("an interrupted send must be unknown and never sent, got %+v", inflight)
		}
		events := gw.snapshot()
		checkOrdered(t, events)
		seen := make(map[string]bool)
		for _, evt := range events {
			if evt.Type == protocol.EventMessage {
				if seen[evt.EventID] {
					t.Fatalf("message %s delivered twice", evt.EventID)
				}
				seen[evt.EventID] = true
			}
		}
	})

	t.Run("no plaintext content on disk", func(t *testing.T) {
		checkNoPlaintext(t, dir, []string{"secret-plaintext-hello", "secret-plaintext-image-bytes", "sent from trioditis", "from my phone", "history one"})
	})
}

func checkOrdered(t *testing.T, events []*protocol.Event) {
	t.Helper()
	for i, evt := range events {
		if evt.Seq != int64(i+1) {
			t.Fatalf("event %d has seq %d: the journal has a gap or reordering", i, evt.Seq)
		}
	}
}

// checkNoPlaintext greps every file the bridge host wrote, including SQLite's WAL.
func checkNoPlaintext(t *testing.T, dir string, needles []string) {
	t.Helper()
	files := 0
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		files++
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, needle := range needles {
			if bytes.Contains(data, []byte(needle)) {
				t.Errorf("%s contains plaintext %q", path, needle)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files == 0 {
		t.Fatal("no files to check")
	}
}

var testLogLevel = func() zerolog.Level {
	if lvl, err := zerolog.ParseLevel(os.Getenv("TEST_LOG_LEVEL")); err == nil && lvl != zerolog.NoLevel {
		return lvl
	}
	return zerolog.WarnLevel
}()

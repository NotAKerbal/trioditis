package imessage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

func TestIDs(t *testing.T) {
	for in, want := range map[string]string{
		"iMessage;-;+15550001111": "any;-;+15550001111",
		"SMS;-;+15550001111":      "any;-;+15550001111",
		"any;+;chat123":           "any;+;chat123",
		"iMessage;+;chat123":      "any;+;chat123",
		"weird":                   "weird",
	} {
		if got := chatID(in); string(got) != want {
			t.Errorf("chatID(%q) = %q, want %q", in, got, want)
		}
	}
	if dmAddress("any;-;a@b.co") != "a@b.co" || dmAddress("any;+;chat1") != "" {
		t.Error("dmAddress")
	}
	for in, want := range map[string]string{"p:0/ABC": "ABC", "p:2/ABC": "ABC", "bp:ABC": "ABC", "ABC": "ABC"} {
		if got := targetGUID(in); got != want {
			t.Errorf("targetGUID(%q) = %q", in, got)
		}
	}
	a, b := loginID("@u_isaac:x", "me@Mac"), loginID("@u_isaac:x", "me@Mac")
	if a != b || loginID("@u_isaac:x", "me@Other") == a || strings.ContainsAny(string(a), "|;") {
		t.Errorf("login IDs %q %q", a, loginID("@u_isaac:x", "me@Other"))
	}
	// Two members whose Macs have the same user and host names have two logins.
	if loginID("@u_ada:x", "me@Mac") == a {
		t.Error("another member's Mac with the same names takes the login")
	}
	c := &Client{login: &bridgev2.UserLogin{UserLogin: &database.UserLogin{ID: "mac-1"}}}
	if got := c.userID("Ada@Example.COM"); got != "mac-1|ada@example.com" {
		t.Errorf("userID: %q", got)
	}
	if addr, ok := c.address("mac-1|+15550001111"); !ok || addr != "+15550001111" {
		t.Error("address of our own ghost")
	}
	// Someone as another login knows them isn't this login's to look up.
	if _, ok := c.address("mac-2|+15550001111"); ok {
		t.Error("address of another login's ghost")
	}
	if _, ok := c.address(c.selfID()); ok {
		t.Error("the person's own ID reads as someone's address")
	}
}

func TestValidAddress(t *testing.T) {
	for in, want := range map[string]bool{
		"+15550001111": true, "+447700900123": true, "ada@example.com": true,
		"5550001111": false, "+1": false, "+1555abc": false, "ada@": false, "": false,
	} {
		if validAddress(in) != want {
			t.Errorf("validAddress(%q) = %v", in, !want)
		}
	}
}

func TestTapbacks(t *testing.T) {
	for emoji, want := range map[string]string{"❤️": "love", "❤": "love", "👍": "like", "😂": "laugh", "‼️": "emphasize", "❓": "question", "🎉": ""} {
		if got := tapbackName(emoji); got != want {
			t.Errorf("tapbackName(%q) = %q, want %q", emoji, got, want)
		}
	}
	for text, want := range map[string]string{"Reacted 🎉 to “hi”": "🎉", "Reacted 👍🏽 to an image": "👍🏽", "Reacted ok to x": "", "hello": ""} {
		if got := reactedEmoji(text); got != want {
			t.Errorf("reactedEmoji(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestFileName(t *testing.T) {
	for in, want := range map[[2]string]string{
		{"IMG_1.HEIC", "image/jpeg"}:       "IMG_1.jpeg",
		{"photo.jpg", "image/jpeg"}:        "photo.jpg",
		{"Audio Message.caf", "audio/mp3"}: "Audio Message.mp3",
		{"../../x.pdf", "application/pdf"}: "x.pdf",
		{"", "text/plain"}:                 "file",
	} {
		if got := fileName(in[0], in[1]); got != want {
			t.Errorf("fileName(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestMatchContact(t *testing.T) {
	var contacts []bluebubbles.Contact
	_ = json.Unmarshal([]byte(`[
		{"displayName":"Someone Else","phoneNumbers":[{"address":"+44 20 7946 0000"}]},
		{"firstName":"Ada","lastName":"Lovelace","phoneNumbers":[{"address":"(555) 000-1111"}],"emails":[{"address":"Ada@Example.com"}]}
	]`), &contacts)
	if c := matchContact(contacts, "+15550001111"); c == nil || c.Name() != "Ada Lovelace" {
		t.Errorf("by number: %+v", c)
	}
	if c := matchContact(contacts, "ada@example.com"); c == nil || c.Name() != "Ada Lovelace" {
		t.Errorf("by email: %+v", c)
	}
	if c := matchContact(contacts, "+15559999999"); c != nil {
		t.Errorf("a stranger matched %+v", c)
	}
}

// Only a refusal before anything happened is certain; anything else is left for bridgev2 to
// report as uncertain, which the bridge host records as unknown.
func TestSendErrorCertainty(t *testing.T) {
	for name, tc := range map[string]struct {
		err     error
		certain bool
	}{
		"validation":      {&bluebubbles.Error{Status: 400, FromServer: true, Type: "Validation Error"}, true},
		"a proxy's 400":   {&bluebubbles.Error{Status: 400}, false},
		"private api":     {&bluebubbles.Error{Status: 500, FromServer: true, Type: "iMessage Error", Detail: "iMessage Private API Helper is not connected!"}, true},
		"marked failed":   {&bluebubbles.Error{Status: 500, FromServer: true, Type: "iMessage Error", Failed: &bluebubbles.Message{GUID: "G", Error: 22}}, true},
		"unhandled":       {&bluebubbles.Error{Status: 500, FromServer: true, Type: "Server Error"}, false},
		"timeout":         {&bluebubbles.Error{Status: 504, FromServer: true, Type: "Gateway Timeout"}, false},
		"answer, failed":  {errMarkedFailed, true},
		"answer, no GUID": {errNoGUID, false},
		"refused dial":    {&net.OpError{Op: "dial", Err: errors.New("connection refused")}, true},
		"cut off":         {&net.OpError{Op: "read", Err: errors.New("connection reset")}, false},
		"deadline":        {context.DeadlineExceeded, false},
	} {
		status := bridgev2.WrapErrorInStatus(sendError(tc.err))
		if status.IsCertain != tc.certain {
			t.Errorf("%s: certain %v, want %v", name, status.IsCertain, tc.certain)
		}
	}
	if !errors.Is(sendError(&bluebubbles.Error{Status: 500, FromServer: true, Type: "iMessage Error", Detail: "iMessage Private API is not enabled!"}), errNeedsPrivateAPI) {
		t.Error("a request needing the Private API isn't reported as such")
	}
}

// An edit already applied, as when the message is reported again with a later change, isn't
// applied twice.
func TestConvertEditOnce(t *testing.T) {
	c := &Client{}
	part := &database.Message{ID: "G", PartID: textPart, Metadata: &MessageMetadata{EditedAt: 100}}
	msg := &bluebubbles.Message{GUID: "G", Text: "new text", DateEdited: 100}
	if _, err := c.convertEdit(context.Background(), nil, nil, []*database.Message{part}, msg); !errors.Is(err, bridgev2.ErrIgnoringRemoteEvent) {
		t.Fatalf("an applied edit: %v", err)
	}
	msg.DateEdited = 200
	edit, err := c.convertEdit(context.Background(), nil, nil, []*database.Message{part}, msg)
	if err != nil || len(edit.ModifiedParts) != 1 || edit.ModifiedParts[0].Content.Body != "new text" {
		t.Fatalf("a new edit: %+v, %v", edit, err)
	}
	if part.Metadata.(*MessageMetadata).EditedAt != 200 {
		t.Error("the edit's time wasn't kept")
	}
	file := &database.Message{ID: "G", PartID: "a0", Metadata: &MessageMetadata{}}
	if _, err = c.convertEdit(context.Background(), nil, nil, []*database.Message{file}, msg); !errors.Is(err, bridgev2.ErrIgnoringRemoteEvent) {
		t.Errorf("an edit to a file alone: %v", err)
	}
}

type recordingMac struct {
	lock       sync.Mutex
	privateAPI bool
	requests   []string
	bodies     []map[string]any
	// sendAnswer, if set, is what a send is answered with.
	sendAnswer string
}

func (m *recordingMac) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.lock.Lock()
		m.requests = append(m.requests, r.Method+" "+r.URL.Path)
		m.bodies = append(m.bodies, body)
		privateAPI, sendAnswer := m.privateAPI, m.sendAnswer
		m.lock.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/server/info":
			_, _ = fmt.Fprintf(w, `{"status":200,"data":{"computer_id":"me@Mac","private_api":%v,"helper_connected":%v}}`, privateAPI, privateAPI)
		case strings.HasPrefix(r.URL.Path, "/api/v1/chat/any;-;"):
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"status":404,"error":{"type":"Database Error","message":"Chat does not exist!"}}`))
		case r.URL.Path == "/api/v1/chat/new":
			_, _ = w.Write([]byte(`{"status":200,"data":{"guid":"iMessage;-;+15550002222","messages":[{"guid":"FIRST","dateCreated":1700000000000,"isFromMe":true}]}}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/message/") && sendAnswer != "":
			_, _ = w.Write([]byte(sendAnswer))
		default:
			_, _ = w.Write([]byte(`{"status":200,"data":{"guid":"iMessage;+;chat1"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (m *recordingMac) sends() []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	var out []string
	for _, r := range m.requests {
		if strings.HasPrefix(r, "POST /api/v1/message") || strings.HasPrefix(r, "POST /api/v1/attachment") || r == "POST /api/v1/chat/new" {
			out = append(out, r)
		}
	}
	return out
}

func (m *recordingMac) lastBody() map[string]any {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.bodies[len(m.bodies)-1]
}

func testClient(t *testing.T, srv *httptest.Server) *Client {
	bb, err := bluebubbles.New(srv.URL, "pw", func(netip.Addr) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	return &Client{conn: &Connector{}, login: &bridgev2.UserLogin{UserLogin: &database.UserLogin{ID: "mac-1"}}, bb: bb}
}

func portal(id string) *bridgev2.Portal {
	return &bridgev2.Portal{Portal: &database.Portal{PortalKey: networkid.PortalKey{ID: networkid.PortalID(id), Receiver: "mac-1"}}}
}

func matrixMessage(p *bridgev2.Portal, content *event.MessageEventContent) *bridgev2.MatrixMessage {
	return &bridgev2.MatrixMessage{MatrixEventBase: bridgev2.MatrixEventBase[*event.MessageEventContent]{Content: content, Portal: p}}
}

// A direct chat started from Trioditis doesn't exist in Messages until its first message: that
// message makes it, once.
func TestFirstMessageMakesTheChat(t *testing.T) {
	mac := &recordingMac{privateAPI: true}
	c := testClient(t, mac.server(t))
	resp, err := c.HandleMatrixMessage(context.Background(), matrixMessage(portal("any;-;+15550002222"), &event.MessageEventContent{MsgType: event.MsgText, Body: "hi"}))
	if err != nil || resp.DB.ID != "FIRST" || resp.DB.PartID != textPart {
		t.Fatalf("%+v, %v", resp, err)
	}
	if sends := mac.sends(); len(sends) != 1 || sends[0] != "POST /api/v1/chat/new" {
		t.Fatalf("sends %v", sends)
	}
	if b := mac.lastBody(); b["message"] != "hi" || b["service"] != "iMessage" || b["method"] != "private-api" {
		t.Errorf("chat/new body %v", b)
	}
	// A file can't start a chat.
	_, err = c.HandleMatrixMessage(context.Background(), matrixMessage(portal("any;-;+15550002222"), &event.MessageEventContent{MsgType: event.MsgImage, Body: "x.png", FileName: "x.png"}))
	if !errors.Is(err, errNewChatText) {
		t.Errorf("a file first: %v", err)
	}
}

// Without the Private API the Mac only receives: every send and change is refused, certainly,
// before anything goes, after asking the Mac whether its helper has started since.
func TestWithoutPrivateAPI(t *testing.T) {
	mac := &recordingMac{}
	c := testClient(t, mac.server(t))
	group := portal("any;+;chat1")
	ctx := context.Background()

	refused := func(what string, err error) {
		t.Helper()
		if !errors.Is(err, errNeedsPrivateAPI) {
			t.Errorf("%s: %v", what, err)
		}
	}
	_, err := c.HandleMatrixMessage(ctx, matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgText, Body: "hi"}))
	refused("a text", err)
	_, err = c.HandleMatrixMessage(ctx, matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgImage, Body: "x.png", FileName: "x.png"}))
	refused("a file", err)
	refused("an edit", c.HandleMatrixEdit(ctx, &bridgev2.MatrixEdit{EditTarget: &database.Message{ID: "G", PartID: textPart}}))
	refused("unsending", c.HandleMatrixMessageRemove(ctx, &bridgev2.MatrixMessageRemove{TargetMessage: &database.Message{ID: "G"}}))
	if sends := mac.sends(); len(sends) != 0 {
		t.Errorf("sent anyway: %v", sends)
	}
	if status := bridgev2.WrapErrorInStatus(errNeedsPrivateAPI); !status.IsCertain || status.ErrorReason != event.MessageStatusUnsupported {
		t.Errorf("refusal status %+v", status)
	}
	if f := c.GetCapabilities(ctx, group); f.Reaction != event.CapLevelRejected || len(f.File) != 0 {
		t.Error("a receive-only chat offers sending")
	}

	// The helper starts: the next send finds out, and goes, as a reply, in the chat's own GUID.
	mac.lock.Lock()
	mac.privateAPI = true
	mac.sendAnswer = `{"status":200,"data":{"guid":"SENT","dateCreated":1700000000000,"isFromMe":true}}`
	mac.lock.Unlock()
	msg := matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgText, Body: "a reply"})
	msg.ReplyTo = &database.Message{ID: "G"}
	if _, err = c.HandleMatrixMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if last := mac.lastBody(); last["selectedMessageGuid"] != "G" || last["method"] != "private-api" || last["chatGuid"] != "iMessage;+;chat1" {
		t.Errorf("reply body %v", last)
	}
	if f := c.GetCapabilities(ctx, group); f.Reaction != event.CapLevelFullySupported || f.EditMaxCount != 5 {
		t.Error("the chat doesn't offer what the Private API gives")
	}

	// An answer whose message Messages marked failed didn't go; one naming no message may have.
	mac.lock.Lock()
	mac.sendAnswer = `{"status":200,"data":{"guid":"SENT2","error":22}}`
	mac.lock.Unlock()
	_, err = c.HandleMatrixMessage(ctx, matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgText, Body: "x"}))
	if status := bridgev2.WrapErrorInStatus(err); !errors.Is(err, errMarkedFailed) || !status.IsCertain {
		t.Errorf("marked failed: %v", err)
	}
	mac.lock.Lock()
	mac.sendAnswer = `{"status":200,"data":{}}`
	mac.lock.Unlock()
	_, err = c.HandleMatrixMessage(ctx, matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgText, Body: "y"}))
	if status := bridgev2.WrapErrorInStatus(err); !errors.Is(err, errNoGUID) || status.IsCertain {
		t.Errorf("no GUID: %v", err)
	}
}

// The server answers a tapback with its message without checking whether Messages marked it
// failed; the connector checks.
func TestTapbackAnswerChecked(t *testing.T) {
	mac := &recordingMac{privateAPI: true, sendAnswer: `{"status":200,"data":{"guid":"TB","error":22}}`}
	c := testClient(t, mac.server(t))
	msg := &bridgev2.MatrixReaction{
		MatrixEventBase: bridgev2.MatrixEventBase[*event.ReactionEventContent]{Portal: portal("any;+;chat1")},
		TargetMessage:   &database.Message{ID: "G"},
		PreHandleResp:   &bridgev2.MatrixReactionPreResponse{Emoji: "❤️"},
	}
	if _, err := c.HandleMatrixReaction(context.Background(), msg); !errors.Is(err, errMarkedFailed) {
		t.Errorf("a failed tapback: %v", err)
	}
	mac.lock.Lock()
	mac.sendAnswer = `{"status":200,"data":{"guid":"TB2"}}`
	mac.lock.Unlock()
	if _, err := c.HandleMatrixReaction(context.Background(), msg); err != nil {
		t.Errorf("a tapback that went: %v", err)
	}
	if last := mac.lastBody(); last["reaction"] != "love" || last["selectedMessageGuid"] != "G" {
		t.Errorf("tapback body %v", last)
	}
}

// A catch-up in which bridgev2 couldn't take a message fails, so the time synced up to stays
// and the next one fetches it again; after maxAttempts the message is left, so it can't hold
// the login back for good.
func TestCatchUpHoldsBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":200,"data":[
			{"guid":"A","text":"a","dateCreated":1,"chats":[{"guid":"iMessage;-;+15550001111"}],"handle":{"address":"+15550001111"}},
			{"guid":"B","text":"b","dateCreated":2,"chats":[{"guid":"iMessage;-;+15550001111"}],"handle":{"address":"+15550001111"}}
		]}`))
	}))
	defer srv.Close()
	c := testClient(t, srv)
	c.failures = map[string]int{}
	var taken []string
	c.take = func(m *bluebubbles.Message) bool {
		taken = append(taken, m.GUID)
		return m.GUID != "A"
	}
	ctx := context.Background()
	for attempt := 1; attempt < maxAttempts; attempt++ {
		if err := c.catchUpSince(ctx, 0); !errors.Is(err, errNotTaken) {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
	}
	if err := c.catchUpSince(ctx, 0); err != nil {
		t.Fatalf("the last attempt: %v", err)
	}
	// Every message is handed over each time; the one after the failure isn't held up.
	if len(taken) != 2*maxAttempts || taken[1] != "B" {
		t.Errorf("handed over %v", taken)
	}
}

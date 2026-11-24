package imessage

import (
	"context"
	"encoding/json"
	"errors"
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
	a, b := loginID("MAC-1"), loginID("MAC-1")
	if a != b || loginID("MAC-2") == a || strings.ContainsAny(string(a), "|;") {
		t.Errorf("login IDs %q %q", a, loginID("MAC-2"))
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
		"validation":    {&bluebubbles.Error{Status: 400, Type: "Validation Error"}, true},
		"private api":   {&bluebubbles.Error{Status: 500, Type: "iMessage Error", Detail: "iMessage Private API Helper is not connected!"}, true},
		"marked failed": {&bluebubbles.Error{Status: 500, Type: "iMessage Error", Failed: &bluebubbles.Message{GUID: "G", Error: 22}}, true},
		"unhandled":     {&bluebubbles.Error{Status: 500, Type: "Server Error"}, false},
		"timeout":       {&bluebubbles.Error{Status: 504, Type: "Gateway Timeout"}, false},
		"refused dial":  {&net.OpError{Op: "dial", Err: errors.New("connection refused")}, true},
		"cut off":       {&net.OpError{Op: "read", Err: errors.New("connection reset")}, false},
		"deadline":      {context.DeadlineExceeded, false},
	} {
		status := bridgev2.WrapErrorInStatus(sendError(tc.err))
		if status.IsCertain != tc.certain {
			t.Errorf("%s: certain %v, want %v", name, status.IsCertain, tc.certain)
		}
	}
	if !errors.Is(sendError(&bluebubbles.Error{Status: 500, Type: "iMessage Error", Detail: "iMessage Private API is not enabled!"}), errNeedsPrivateAPI) {
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
	lock     sync.Mutex
	requests []string
	bodies   []map[string]any
}

func (m *recordingMac) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		m.lock.Lock()
		m.requests = append(m.requests, r.Method+" "+r.URL.Path)
		m.bodies = append(m.bodies, body)
		m.lock.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v1/chat/any;-;"):
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"status":404,"error":{"type":"Database Error","message":"Chat does not exist!"}}`))
		case r.URL.Path == "/api/v1/chat/new":
			_, _ = w.Write([]byte(`{"status":200,"data":{"guid":"iMessage;-;+15550002222","messages":[{"guid":"FIRST","dateCreated":1700000000000,"isFromMe":true}]}}`))
		default:
			_, _ = w.Write([]byte(`{"status":200,"data":{"guid":"iMessage;+;chat1"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
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
	mac := &recordingMac{}
	c := testClient(t, mac.server(t))
	resp, err := c.HandleMatrixMessage(context.Background(), matrixMessage(portal("any;-;+15550002222"), &event.MessageEventContent{MsgType: event.MsgText, Body: "hi"}))
	if err != nil || resp.DB.ID != "FIRST" || resp.DB.PartID != textPart {
		t.Fatalf("%+v, %v", resp, err)
	}
	if len(mac.requests) != 2 || mac.requests[1] != "POST /api/v1/chat/new" {
		t.Fatalf("requests %v", mac.requests)
	}
	if b := mac.bodies[1]; b["message"] != "hi" || b["service"] != "iMessage" || b["method"] != "apple-script" {
		t.Errorf("chat/new body %v", b)
	}
	// A file can't start a chat.
	_, err = c.HandleMatrixMessage(context.Background(), matrixMessage(portal("any;-;+15550002222"), &event.MessageEventContent{MsgType: event.MsgImage, Body: "x.png", FileName: "x.png"}))
	if !errors.Is(err, errNewChatText) {
		t.Errorf("a file first: %v", err)
	}
}

// Without the Private API, what needs it is refused, certainly, before anything is sent.
func TestWithoutPrivateAPI(t *testing.T) {
	mac := &recordingMac{}
	c := testClient(t, mac.server(t))
	group := portal("any;+;chat1")
	ctx := context.Background()

	msg := matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgText, Body: "a reply"})
	msg.ReplyTo = &database.Message{ID: "G"}
	if _, err := c.HandleMatrixMessage(ctx, msg); !errors.Is(err, errNeedsPrivateAPI) {
		t.Errorf("a reply: %v", err)
	}
	_, err := c.HandleMatrixMessage(ctx, matrixMessage(group, &event.MessageEventContent{MsgType: event.MsgImage, Body: "look", FileName: "x.png"}))
	if !errors.Is(err, errNeedsPrivateAPI) {
		t.Errorf("a captioned file: %v", err)
	}
	if err = c.HandleMatrixEdit(ctx, &bridgev2.MatrixEdit{EditTarget: &database.Message{ID: "G", PartID: textPart}}); !errors.Is(err, errNeedsPrivateAPI) {
		t.Errorf("an edit: %v", err)
	}
	if err = c.HandleMatrixMessageRemove(ctx, &bridgev2.MatrixMessageRemove{TargetMessage: &database.Message{ID: "G"}}); !errors.Is(err, errNeedsPrivateAPI) {
		t.Errorf("unsending: %v", err)
	}
	for _, r := range mac.requests {
		if strings.HasPrefix(r, "POST /api/v1/message") || strings.HasPrefix(r, "POST /api/v1/attachment") {
			t.Errorf("sent anyway: %s", r)
		}
	}
	if status := bridgev2.WrapErrorInStatus(errNeedsPrivateAPI); !status.IsCertain || status.ErrorReason != event.MessageStatusUnsupported {
		t.Errorf("refusal status %+v", status)
	}
	if f := c.GetCapabilities(ctx, group); f.Reaction != event.CapLevelRejected || f.File[event.MsgImage].Caption != event.CapLevelRejected {
		t.Error("the chat offers what needs the Private API")
	}
	c.privateAPI.Store(true)
	if f := c.GetCapabilities(ctx, group); f.Reaction != event.CapLevelFullySupported || f.EditMaxCount != 5 {
		t.Error("the chat doesn't offer what the Private API gives")
	}
	// With it, a reply goes to the message it answers, in the chat's own GUID.
	if _, err = c.HandleMatrixMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}
	last := mac.bodies[len(mac.bodies)-1]
	if last["selectedMessageGuid"] != "G" || last["method"] != "private-api" || last["chatGuid"] != "iMessage;+;chat1" {
		t.Errorf("reply body %v", last)
	}
}

package networks

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"unsafe"

	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	"go.mau.fi/mautrix-linkedin/pkg/linkedingo"
	"maunium.net/go/mautrix/bridgev2"
)

// linkedinDisplayname is the connector's own template without its " (LinkedIn)" suffix: the
// app shows each contact with its network's badge, so the suffix would only be noise.
const linkedinDisplayname = "{{ with .Organization }}{{ . }}{{ else }}{{ .FirstName }} {{ .LastName }}{{ end }}"

func init() {
	register("linkedin", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &linkedin.LinkedInConnector{}
			if _, err := withDefaults("LinkedIn", conn); err != nil {
				return nil, err
			}
			conn.Config.DisplaynameTemplate = linkedinDisplayname
			if err := conn.Config.PostProcess(); err != nil {
				return nil, fmt.Errorf("failed to set the LinkedIn displayname template: %w", err)
			}
			// Login responses are never logged, even redacted: they carry session cookies.
			conn.Config.LogRedactedLoginResponses = false
			return &linkedinConnector{conn}, nil
		},
	})
}

// linkedinConnector is mautrix-linkedin with one change: a message is never sent twice.
// linkedingo's DoRaw repeats every request, body and all, up to five times after a transport
// error or a 502, 503 or 504, so a message whose answer was lost would go out again before
// the bridge host could record it as unknown. Everything else is the connector's own: the
// embedded pointer keeps every optional interface it implements.
type linkedinConnector struct {
	*linkedin.LinkedInConnector
}

// LoadUserLogin gives the login's HTTP client the send-once transport. bridgev2 calls it for
// stored logins and, through the bridge's connector, for new ones, so every client has it
// before it connects. A connector whose client can't be reached any more fails the login
// rather than sending without it.
func (l *linkedinConnector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	if err := l.LinkedInConnector.LoadUserLogin(ctx, login); err != nil {
		return err
	}
	client, ok := login.Client.(*linkedin.LinkedInClient)
	if !ok {
		return fmt.Errorf("linkedin: unexpected client %T", login.Client)
	}
	httpClient, err := linkedinHTTPClient(client)
	if err != nil {
		return err
	}
	httpClient.Transport = &linkedinSendOnce{next: httpClient.Transport}
	return nil
}

// linkedinHTTPClient reaches the http.Client a login's requests go through. Both fields on
// the way (LinkedInClient.client, linkedingo.Client.http) are private and the connector has
// no option for its transport, so this is read by reflection, here only. If an upgrade moves
// or retypes either field this returns an error, and TestLinkedInSendOnceReachesTheClient
// fails.
func linkedinHTTPClient(client *linkedin.LinkedInClient) (*http.Client, error) {
	inner, err := privateField[*linkedingo.Client](client, "client")
	if err != nil {
		return nil, err
	}
	return linkedingoHTTPClient(inner)
}

func linkedingoHTTPClient(client *linkedingo.Client) (*http.Client, error) {
	httpClient, err := privateField[*http.Client](client, "http")
	if err != nil {
		return nil, err
	}
	if httpClient == nil {
		return nil, errors.New("linkedin: the client has no http.Client")
	}
	return httpClient, nil
}

// privateField reads the unexported field name of the struct ptr points to, which must have
// type T exactly.
func privateField[T any](ptr any, name string) (T, error) {
	var zero T
	v := reflect.ValueOf(ptr)
	if v.Kind() != reflect.Pointer || v.IsNil() || v.Elem().Kind() != reflect.Struct {
		return zero, fmt.Errorf("linkedin: %T isn't a pointer to a struct", ptr)
	}
	field := v.Elem().FieldByName(name)
	if !field.IsValid() {
		return zero, fmt.Errorf("linkedin: %T has no field %q any more", ptr, name)
	}
	if want := reflect.TypeFor[T](); field.Type() != want {
		return zero, fmt.Errorf("linkedin: %T.%s is a %s, not a %s", ptr, name, field.Type(), want)
	}
	return *(*T)(unsafe.Pointer(field.UnsafeAddr())), nil
}

// linkedinMessagesPath is where linkedingo creates a message (SendMessage, and NewChat for a
// new group's first message), with ?action=createMessage, adds or takes away a reaction, with
// ?action=reactWithEmoji or unreactWithEmoji, and deletes a message, with ?action=recall. An
// edit (EditMessage) goes to the message's own path under it: <path>/<its URN>.
const linkedinMessagesPath = "/voyager/api/voyagerMessagingDashMessengerMessages"

// linkedinOnceActions are the actions that go to LinkedIn once: repeating one could add a
// message twice, or undo what the person did meanwhile elsewhere (a reaction they took away, or
// a message deleted after they sent it again).
var linkedinOnceActions = map[string]bool{
	"createMessage": true, "reactWithEmoji": true, "unreactWithEmoji": true, "recall": true,
}

func isLinkedInOnce(req *http.Request) bool {
	if req.Method != http.MethodPost || req.URL.Host != "www.linkedin.com" {
		return false
	}
	// An edit repeated could overwrite a newer one the person made on their phone meanwhile.
	if strings.HasPrefix(req.URL.Path, linkedinMessagesPath+"/") {
		return true
	}
	return req.URL.Path == linkedinMessagesPath && linkedinOnceActions[req.URL.Query().Get("action")]
}

// linkedinSendOnce makes an ambiguous outcome of creating, editing or deleting a message, or of
// a reaction, final. DoRaw gives a
// response back without repeating it unless it is a 502, 503 or 504, so a create that failed
// in transport, with any 5xx, or with a redirect (which the client doesn't follow, and which
// says nothing of whether the message was created) comes back as 500 Internal Server Error.
// The connector reports a 5xx as a server error it isn't certain about, which the bridge
// host records as unknown; a reaction it isn't sure of is never confirmed, so the client goes
// back to what the server says; an edit it isn't sure of is unknown too, and a deletion is never
// confirmed. Every other request is untouched.
type linkedinSendOnce struct {
	next http.RoundTripper
}

func (t *linkedinSendOnce) RoundTrip(req *http.Request) (*http.Response, error) {
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	if !isLinkedInOnce(req) {
		return next.RoundTrip(req)
	}
	resp, err := next.RoundTrip(req)
	if err == nil && resp.StatusCode < 300 {
		return resp, nil
	} else if err == nil && resp.StatusCode >= 400 && resp.StatusCode < 500 {
		// A refusal is LinkedIn's own answer, and DoRaw doesn't repeat it.
		return resp, nil
	}
	reason := "transport error"
	header := http.Header{}
	if err == nil {
		reason = fmt.Sprintf("status %d", resp.StatusCode)
		// The cookie jar still sees what LinkedIn set, a signed-out session included, so the
		// next request reports it.
		for _, cookie := range resp.Header.Values("Set-Cookie") {
			header.Add("Set-Cookie", cookie)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
		_ = resp.Body.Close()
	}
	return &http.Response{
		Status:     "500 Internal Server Error (Trioditis: send not repeated after " + reason + ")",
		StatusCode: http.StatusInternalServerError,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}, nil
}

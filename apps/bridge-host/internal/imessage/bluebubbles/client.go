// Package bluebubbles is a client for BlueBubbles Server's REST API and socket: the parts the
// iMessage connector uses. https://bluebubbles.app
package bluebubbles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Client talks to one BlueBubbles Server.
type Client struct {
	base     *url.URL
	password string
	// reads may be retried by whoever calls; sends are made once, by a client that never
	// retries or follows a redirect (a redirected POST could be sent twice).
	reads *http.Client
	sends *http.Client
}

// Timeouts. The server answers a send once Messages has it in its database, which can take a
// while (an attachment uploads first); past sendTimeout the outcome is unknown.
const (
	readTimeout = 60 * time.Second
	sendTimeout = 150 * time.Second
	// downloadTimeout bounds fetching one file, its body included.
	downloadTimeout = 5 * time.Minute
	// maxBody bounds an answer read into memory (not a download, which streams).
	maxBody = 64 << 20
)

// New makes a client for the server at serverURL (http or https, as BlueBubbles shows it),
// which takes password. It connects only to addresses allow allows (the public internet
// alone if nil).
func New(serverURL, password string, allow AddressPolicy) (*Client, error) {
	base, err := ParseServerURL(serverURL)
	if err != nil {
		return nil, err
	}
	if allow == nil {
		allow = Policy{}.Allows
	}
	transport := &http.Transport{
		// Never through a proxy from the environment: it would dial for us, past the check.
		Proxy:                 nil,
		DialContext:           guardedDialer(allow).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: sendTimeout,
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{
		base:     base,
		password: password,
		reads:    &http.Client{Transport: transport, Timeout: readTimeout, CheckRedirect: noRedirect},
		sends:    &http.Client{Transport: transport, Timeout: sendTimeout, CheckRedirect: noRedirect},
	}, nil
}

func (c *Client) readClient() *http.Client { return c.reads }

// ParseServerURL reads a server address as people write it: with or without its scheme
// (http when none is given, as BlueBubbles' own local addresses are), and without a path.
func ParseServerURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("bluebubbles: the server address is empty")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("bluebubbles: the server address isn't a URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("bluebubbles: the server address must start with http:// or https://")
	}
	if u.Host == "" || u.User != nil {
		return nil, errors.New("bluebubbles: the server address has no host")
	}
	u.Path, u.RawPath = strings.TrimRight(u.Path, "/"), ""
	u.RawQuery, u.Fragment = "", ""
	return u, nil
}

// ServerURL is the server's address, as the client uses it.
func (c *Client) ServerURL() string { return c.base.String() }

// Error is the server answering a request with a failure.
type Error struct {
	Status int
	// FromServer says the answer was BlueBubbles' own error envelope, with the status it
	// states matching the HTTP one: not a proxy's or tunnel's page in front of it.
	FromServer bool
	// Type and Detail are the server's error type ("iMessage Error", "Validation Error", …)
	// and its message. Either can carry anything the server or a proxy wrote, the person's
	// words included: they are only compared, never logged or put in Error().
	Type   string
	Detail string
	// Failed is the message Messages made of a send it then marked failed, when the server
	// says so: Messages has it, with its error code set, and won't send it on its own.
	Failed *Message
}

func (e *Error) Error() string {
	return fmt.Sprintf("bluebubbles: server answered %d (%s)", e.Status, e.kind())
}

// kind is the error's type as one of a fixed set of words, for Error().
func (e *Error) kind() string {
	switch {
	case !e.FromServer:
		return "not BlueBubbles' answer"
	case e.Failed != nil:
		return "message failed"
	case e.NeedsPrivateAPI():
		return "needs the Private API"
	}
	switch e.Type {
	case "Validation Error", "Authentication Error", "Database Error", "iMessage Error", "Server Error", "Gateway Timeout":
		return e.Type
	}
	return "other"
}

// Unauthorized says the password was refused.
func (e *Error) Unauthorized() bool {
	return e.FromServer && e.Status == http.StatusUnauthorized && e.Type == "Authentication Error"
}

// Throttled says the server is refusing attempts after too many wrong passwords.
func (e *Error) Throttled() bool { return e.FromServer && e.Status == http.StatusTooManyRequests }

// NotFound says the server has no such thing (a chat, a message).
func (e *Error) NotFound() bool {
	return e.FromServer && e.Status == http.StatusNotFound && e.Type == "Database Error"
}

// The server's words when a request needs the Private API, its helper running, or a newer
// macOS (utils.ts checkPrivateApiStatus, messageInterface.ts).
var privateAPIRefusals = []string{
	"iMessage Private API is not enabled!",
	"iMessage Private API Helper is not connected!",
	"Unsend message is only supported on macOS Ventura and newer!",
}

// NeedsPrivateAPI says the request needs the Private API, which isn't switched on or whose
// helper isn't running in Messages, or a newer macOS: the server refused it without trying.
func (e *Error) NeedsPrivateAPI() bool {
	return e.FromServer && e.Status == http.StatusInternalServerError && e.Type == "iMessage Error" &&
		slices.Contains(privateAPIRefusals, e.Detail)
}

// Certain says the request certainly had no effect beyond what the error says: the server
// refused it before acting (it was malformed, named something that isn't there, needed a
// password or the Private API), or Messages marked the message it made failed. Anything else
// (a timeout, an unexpected error, a proxy's answer) may have sent it.
func (e *Error) Certain() bool {
	if !e.FromServer {
		return false
	}
	switch {
	case e.Status == http.StatusBadRequest && e.Type == "Validation Error":
		return true
	case e.Unauthorized(), e.Throttled(), e.NotFound(), e.NeedsPrivateAPI(), e.Failed != nil:
		return true
	}
	return false
}

type envelope struct {
	Status  int             `json:"status"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
	Error   *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
	Metadata *struct {
		Total  int `json:"total"`
		Offset int `json:"offset"`
		Limit  int `json:"limit"`
		Count  int `json:"count"`
	} `json:"metadata"`
}

// endpoint is the URL for an API path, whose parts are already escaped (a chat GUID's ";"
// must reach the server as "%3B", not split the path).
func (c *Client) endpoint(path string, query url.Values) string {
	q := url.Values{}
	for k, v := range query {
		q[k] = v
	}
	q.Set("password", c.password)
	return c.base.String() + path + "?" + q.Encode()
}

// do makes a request and reads the server's envelope, decoding its data into out.
func (c *Client) do(ctx context.Context, hc *http.Client, method, path string, query url.Values, body io.Reader, contentType string, out any) (*envelope, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path, query), body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		// The URL carries the password: never let it into an error that might be logged.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return nil, fmt.Errorf("bluebubbles: %s %s: %w", method, path, urlErr.Err)
		}
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("bluebubbles: reading the answer to %s %s: %w", method, path, err)
	}
	var env envelope
	if jsonErr := json.Unmarshal(data, &env); jsonErr != nil || resp.StatusCode >= 300 {
		e := &Error{Status: resp.StatusCode}
		if jsonErr == nil && env.Error != nil && env.Status == resp.StatusCode {
			e.FromServer = true
			e.Type, e.Detail = env.Error.Type, env.Error.Message
		}
		// A send Messages took and marked failed comes back with its message, error code set
		// (messageRouter.ts: "Message sent with an error", or a rejected send's own message).
		if e.FromServer && e.Type == "iMessage Error" && len(env.Data) > 0 {
			var failed Message
			if json.Unmarshal(env.Data, &failed) == nil && failed.GUID != "" && failed.Error != 0 {
				e.Failed = &failed
			}
		}
		return nil, e
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err = json.Unmarshal(env.Data, out); err != nil {
			return nil, fmt.Errorf("bluebubbles: reading the answer to %s %s: %w", method, path, err)
		}
	}
	return &env, nil
}

func (c *Client) get(ctx context.Context, path string, query url.Values, out any) (*envelope, error) {
	return c.do(ctx, c.reads, http.MethodGet, path, query, nil, "", out)
}

func (c *Client) postJSON(ctx context.Context, hc *http.Client, path string, body, out any) (*envelope, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return c.do(ctx, hc, http.MethodPost, path, nil, bytes.NewReader(data), "application/json", out)
}

// ServerInfo asks the server about itself; it also checks the password.
func (c *Client) ServerInfo(ctx context.Context) (*ServerInfo, error) {
	var info ServerInfo
	if _, err := c.get(ctx, "/api/v1/server/info", nil, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// Chats lists chats, the most recently active first, each with its last message.
func (c *Client) Chats(ctx context.Context, offset, limit int) ([]Chat, error) {
	var chats []Chat
	_, err := c.postJSON(ctx, c.reads, "/api/v1/chat/query", map[string]any{
		"offset": offset, "limit": limit, "sort": "lastmessage", "with": []string{"lastMessage"},
	}, &chats)
	return chats, err
}

// Chat fetches one chat with its participants.
func (c *Client) Chat(ctx context.Context, guid string) (*Chat, error) {
	var chat Chat
	if _, err := c.get(ctx, "/api/v1/chat/"+url.PathEscape(guid), url.Values{"with": {"participants"}}, &chat); err != nil {
		return nil, err
	}
	return &chat, nil
}

// MessageQuery picks messages in one chat.
type MessageQuery struct {
	// After and Before bound the messages' times (Unix ms); zero is unbounded.
	After, Before int64
	Limit         int
	// Ascending lists the oldest first; otherwise the newest come first.
	Ascending bool
}

// ChatMessages lists messages in a chat (at most 1000), each with its attachments.
func (c *Client) ChatMessages(ctx context.Context, chatGUID string, q MessageQuery) ([]Message, error) {
	query := url.Values{
		"offset": {"0"},
		"limit":  {strconv.Itoa(q.Limit)},
		"sort":   {map[bool]string{true: "ASC", false: "DESC"}[q.Ascending]},
		"with":   {"attachment,message.messageSummaryInfo"},
	}
	if q.After > 0 {
		query.Set("after", strconv.FormatInt(q.After, 10))
	}
	if q.Before > 0 {
		query.Set("before", strconv.FormatInt(q.Before, 10))
	}
	var messages []Message
	_, err := c.get(ctx, "/api/v1/chat/"+url.PathEscape(chatGUID)+"/message", query, &messages)
	return messages, err
}

// MessagesSince lists messages in every chat created at or after after (Unix ms), oldest
// first, one page of at most limit from offset, each with its chat, attachments and what was
// unsent. It is how a reconnect catches up.
func (c *Client) MessagesSince(ctx context.Context, after int64, offset, limit int) ([]Message, error) {
	var messages []Message
	// after must be a JSON number: a string passes the server's check and matches nothing.
	_, err := c.postJSON(ctx, c.reads, "/api/v1/message/query", map[string]any{
		"after": after, "sort": "ASC", "offset": offset, "limit": limit,
		"with": []string{"chat", "attachment", "messageSummaryInfo"},
	}, &messages)
	return messages, err
}

// Message fetches one message.
func (c *Client) Message(ctx context.Context, guid string) (*Message, error) {
	var msg Message
	if _, err := c.get(ctx, "/api/v1/message/"+url.PathEscape(guid), url.Values{"with": {"chats,attachment,messageSummaryInfo"}}, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// SendMethod is how the server has Messages send: by scripting the app, or through the
// Private API helper inside it, which replies and effects need.
type SendMethod string

const (
	MethodAppleScript SendMethod = "apple-script"
	MethodPrivateAPI  SendMethod = "private-api"
)

// TextMessage is a text to send.
type TextMessage struct {
	ChatGUID string     `json:"chatGuid"`
	TempGUID string     `json:"tempGuid"`
	Message  string     `json:"message"`
	Method   SendMethod `json:"method"`
	// A reply names the message it answers (Private API only).
	SelectedMessageGUID string `json:"selectedMessageGuid,omitempty"`
	PartIndex           int    `json:"partIndex,omitempty"`
}

// SendText sends a text, once, and returns the message Messages made of it. The chat must be
// one Messages has, named by its own GUID: the server matches what it sent by that.
func (c *Client) SendText(ctx context.Context, msg TextMessage) (*Message, error) {
	var sent Message
	if _, err := c.postJSON(ctx, c.sends, "/api/v1/message/text", msg, &sent); err != nil {
		return nil, err
	}
	return &sent, nil
}

// FileMessage is a file to send.
type FileMessage struct {
	ChatGUID            string
	TempGUID            string
	Name                string
	Data                []byte
	Method              SendMethod
	IsAudioMessage      bool
	SelectedMessageGUID string
}

// SendFile sends a file, once, and returns the message Messages made of it.
func (c *Client) SendFile(ctx context.Context, msg FileMessage) (*Message, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	fields := map[string]string{
		"chatGuid": msg.ChatGUID, "tempGuid": msg.TempGUID, "name": msg.Name, "method": string(msg.Method),
	}
	if msg.IsAudioMessage {
		fields["isAudioMessage"] = "true"
	}
	if msg.SelectedMessageGUID != "" {
		fields["selectedMessageGuid"] = msg.SelectedMessageGUID
		fields["partIndex"] = "0"
	}
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	part, err := w.CreateFormFile("attachment", msg.Name)
	if err != nil {
		return nil, err
	}
	if _, err = part.Write(msg.Data); err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil {
		return nil, err
	}
	var sent Message
	if _, err = c.do(ctx, c.sends, http.MethodPost, "/api/v1/message/attachment", nil, &body, w.FormDataContentType(), &sent); err != nil {
		return nil, err
	}
	return &sent, nil
}

// Upload puts a file on the Mac for SendMultipart, returning where it is there. Private API
// only. Nothing is sent.
func (c *Client) Upload(ctx context.Context, name string, data []byte) (string, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("attachment", name)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	if err = w.Close(); err != nil {
		return "", err
	}
	var out struct {
		Path string `json:"path"`
	}
	if _, err = c.do(ctx, c.sends, http.MethodPost, "/api/v1/attachment/upload", nil, &body, w.FormDataContentType(), &out); err != nil {
		return "", err
	}
	if out.Path == "" {
		return "", errors.New("bluebubbles: the upload gave no path")
	}
	return out.Path, nil
}

// MultipartPart is one part of a message sent with SendMultipart: a file uploaded with
// Upload, or text.
type MultipartPart struct {
	PartIndex  int    `json:"partIndex"`
	Text       string `json:"text,omitempty"`
	Attachment string `json:"attachment,omitempty"`
	Name       string `json:"name,omitempty"`
}

// SendMultipart sends one message of several parts (a file and its caption), once. Private
// API only.
func (c *Client) SendMultipart(ctx context.Context, chatGUID, tempGUID, replyTo string, parts []MultipartPart) (*Message, error) {
	body := map[string]any{"chatGuid": chatGUID, "tempGuid": tempGUID, "parts": parts}
	if replyTo != "" {
		body["selectedMessageGuid"], body["partIndex"] = replyTo, 0
	}
	var sent Message
	if _, err := c.postJSON(ctx, c.sends, "/api/v1/message/multipart", body, &sent); err != nil {
		return nil, err
	}
	return &sent, nil
}

// React puts a tapback on a message, or takes it off ("-love"). Private API only.
func (c *Client) React(ctx context.Context, chatGUID, targetGUID, reaction string) (*Message, error) {
	var sent Message
	_, err := c.postJSON(ctx, c.sends, "/api/v1/message/react", map[string]any{
		"chatGuid": chatGUID, "selectedMessageGuid": targetGUID, "reaction": reaction, "partIndex": 0,
	}, &sent)
	if err != nil {
		return nil, err
	}
	return &sent, nil
}

// Edit changes a sent message's text, and returns the message as it then is. Private API
// and macOS 13 only. The server answers once the edit shows, or after 30 seconds whether or
// not it did, so check DateEdited.
func (c *Client) Edit(ctx context.Context, guid, text string) (*Message, error) {
	var msg Message
	_, err := c.postJSON(ctx, c.sends, "/api/v1/message/"+url.PathEscape(guid)+"/edit", map[string]any{
		"editedMessage": text, "backwardsCompatibilityMessage": "Edited to “" + text + "”", "partIndex": 0,
	}, &msg)
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

// Unsend takes a sent message back, and returns the message as it then is. Private API and
// macOS 13 only. As with Edit, check DateRetracted.
func (c *Client) Unsend(ctx context.Context, guid string) (*Message, error) {
	var msg Message
	_, err := c.postJSON(ctx, c.sends, "/api/v1/message/"+url.PathEscape(guid)+"/unsend", map[string]any{"partIndex": 0}, &msg)
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

// MarkRead marks a chat read. Private API only.
func (c *Client) MarkRead(ctx context.Context, chatGUID string) error {
	_, err := c.postJSON(ctx, c.sends, "/api/v1/chat/"+url.PathEscape(chatGUID)+"/read", map[string]any{}, nil)
	return err
}

// Typing starts or stops the typing indicator in a chat. Private API only.
func (c *Client) Typing(ctx context.Context, chatGUID string, typing bool) error {
	method := http.MethodDelete
	if typing {
		method = http.MethodPost
	}
	_, err := c.do(ctx, c.sends, method, "/api/v1/chat/"+url.PathEscape(chatGUID)+"/typing", nil, nil, "", nil)
	return err
}

// NewChat starts a direct chat with address on iMessage by sending it its first message,
// once, and returns that message. Messages makes no chat without one.
func (c *Client) NewChat(ctx context.Context, address, tempGUID, text string, method SendMethod) (*Message, error) {
	var chat struct {
		Chat
		Messages []Message `json:"messages"`
	}
	if _, err := c.postJSON(ctx, c.sends, "/api/v1/chat/new", map[string]any{
		"addresses": []string{address}, "service": "iMessage", "method": method, "tempGuid": tempGUID, "message": text,
	}, &chat); err != nil {
		return nil, err
	}
	if len(chat.Messages) == 0 || chat.Messages[0].GUID == "" {
		return nil, errors.New("bluebubbles: the new chat came back without its message")
	}
	msg := chat.Messages[0]
	if len(msg.Chats) == 0 {
		msg.Chats = []Chat{chat.Chat}
	}
	return &msg, nil
}

// Contacts looks up the Mac's Contacts entries for addresses, with their pictures.
func (c *Client) Contacts(ctx context.Context, addresses []string) ([]Contact, error) {
	if len(addresses) == 0 {
		// An empty list asks for every contact.
		return nil, nil
	}
	var contacts []Contact
	_, err := c.postJSON(ctx, c.reads, "/api/v1/contact/query", map[string]any{
		"addresses": addresses, "extraProperties": []string{"avatar"},
	}, &contacts)
	return contacts, err
}

// Download fetches a file: an attachment, or a group chat's picture. It returns the body and
// its type; the caller closes it. Pictures Messages keeps as HEIC come as JPEG.
func (c *Client) Download(ctx context.Context, path string) (io.ReadCloser, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint(path, nil), nil)
	if err != nil {
		return nil, "", err
	}
	// Downloads may be large and slow, but are bounded: one that stalls would hold up the
	// login's events behind it, and nothing cancels a message's conversion.
	hc := *c.reads
	hc.Timeout = downloadTimeout
	resp, err := hc.Do(req)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return nil, "", fmt.Errorf("bluebubbles: downloading: %w", urlErr.Err)
		}
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, "", &Error{Status: resp.StatusCode, Type: "download"}
	}
	return resp.Body, resp.Header.Get("Content-Type"), nil
}

// AttachmentPath is where an attachment downloads from.
func AttachmentPath(guid string) string {
	return "/api/v1/attachment/" + url.PathEscape(guid) + "/download"
}

// ChatIconPath is where a group chat's picture downloads from.
func ChatIconPath(chatGUID string) string {
	return "/api/v1/chat/" + url.PathEscape(chatGUID) + "/icon"
}

// socketURL is the socket's address, with the password as the server takes it there.
func (c *Client) socketURL() string {
	u := *c.base
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = c.base.Path + "/socket.io/"
	u.RawQuery = url.Values{"password": {c.password}, "EIO": {"4"}, "transport": {"websocket"}}.Encode()
	return u.String()
}

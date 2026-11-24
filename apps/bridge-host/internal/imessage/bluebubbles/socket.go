package bluebubbles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"net/url"
	"strings"

	"github.com/coder/websocket"
)

// Event is one event the server pushes over its socket: its name and its payload.
type Event struct {
	Name string
	Data json.RawMessage
}

// ErrSocketRefused is how a socket the server turned away ends, such as for a wrong password.
// Connecting again with the same details won't help.
var ErrSocketRefused = errors.New("bluebubbles: the server refused the socket connection")

// Listen connects to the server's socket and calls onEvent with each event it pushes, in
// order, until ctx ends or the connection drops; it returns why it stopped. onConnected is
// called once the server has accepted the connection, before the first event.
//
// The server speaks socket.io over Engine.IO 4. Only the parts a listener needs are spoken
// here: the handshake, the server's pings, and events on the default namespace.
func (c *Client) Listen(ctx context.Context, onConnected func(), onEvent func(Event)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// The same guarded transport as every request; the socket's life is bounded by ctx and
	// the server's pings, not a client timeout.
	hc := *c.readClient()
	hc.Timeout = 0
	dialCtx, cancelDial := context.WithTimeout(ctx, handshakeTimeout)
	conn, _, err := websocket.Dial(dialCtx, c.socketURL(), &websocket.DialOptions{HTTPClient: &hc})
	cancelDial()
	if err != nil {
		// The socket's URL carries the password, and the library's error can quote it.
		return fmt.Errorf("bluebubbles: connecting the socket: %w", redactURL(err, c.password))
	}
	defer conn.CloseNow()
	// Attachments travel over HTTP, so a frame is an event's JSON; a message with a long text
	// and its chat's details can still pass the library's 32 KiB default.
	conn.SetReadLimit(16 << 20)

	// Engine.IO opens with its settings: how often the server pings, and how long it waits.
	open, err := readFrame(ctx, conn, handshakeTimeout)
	if err != nil {
		return fmt.Errorf("bluebubbles: reading the socket handshake: %w", err)
	}
	if len(open) == 0 || open[0] != '0' {
		return fmt.Errorf("bluebubbles: unexpected socket handshake")
	}
	var settings struct {
		PingInterval int `json:"pingInterval"`
		PingTimeout  int `json:"pingTimeout"`
	}
	if err = json.Unmarshal(open[1:], &settings); err != nil {
		return fmt.Errorf("bluebubbles: reading the socket handshake: %w", err)
	}
	// A connection that has gone quiet past a ping and its grace is gone, even if TCP hasn't
	// noticed: wait that long for each frame before giving up on it.
	silence := time.Duration(settings.PingInterval+settings.PingTimeout) * time.Millisecond
	if silence <= 0 {
		silence = defaultSilence
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte("40")); err != nil {
		return fmt.Errorf("bluebubbles: joining the socket: %w", err)
	}

	connected := false
	for {
		frame, err := readFrame(ctx, conn, silence)
		if err != nil {
			return fmt.Errorf("bluebubbles: socket: %w", err)
		}
		switch {
		case bytes.Equal(frame, []byte("2")):
			// The server's ping; it closes a connection that doesn't answer.
			if err = conn.Write(ctx, websocket.MessageText, []byte("3")); err != nil {
				return fmt.Errorf("bluebubbles: answering the socket's ping: %w", err)
			}
		case bytes.HasPrefix(frame, []byte("40")):
			if !connected {
				connected = true
				if onConnected != nil {
					onConnected()
				}
			}
		case bytes.HasPrefix(frame, []byte("44")):
			return ErrSocketRefused
		case bytes.Equal(frame, []byte("41")), bytes.Equal(frame, []byte("1")):
			return errors.New("bluebubbles: the server closed the socket")
		case bytes.HasPrefix(frame, []byte("42")):
			evt, ok := parseEvent(frame[2:])
			if ok && connected {
				onEvent(evt)
			}
		}
	}
}

const (
	handshakeTimeout = 30 * time.Second
	defaultSilence   = 90 * time.Second
)

// redactURL is err with the password taken out of what it says, keeping what it wraps for
// errors.Is: an address the dialler refused must still read as one.
func redactURL(err error, password string) error {
	if password == "" || !strings.Contains(err.Error(), url.QueryEscape(password)) && !strings.Contains(err.Error(), password) {
		return err
	}
	if errors.Is(err, ErrAddressRefused) {
		return ErrAddressRefused
	}
	return errors.New("the connection failed")
}

func readFrame(ctx context.Context, conn *websocket.Conn, wait time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	_, data, err := conn.Read(ctx)
	return data, err
}

// parseEvent reads a socket.io event packet's body: an optional acknowledgement ID, then a
// JSON array of the event's name and its arguments.
func parseEvent(body []byte) (Event, bool) {
	start := bytes.IndexByte(body, '[')
	if start < 0 {
		return Event{}, false
	}
	if _, err := strconv.Atoi(string(body[:start])); start > 0 && err != nil {
		return Event{}, false
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(body[start:], &parts); err != nil || len(parts) == 0 {
		return Event{}, false
	}
	var evt Event
	if err := json.Unmarshal(parts[0], &evt.Name); err != nil {
		return Event{}, false
	}
	if len(parts) > 1 {
		evt.Data = parts[1]
	}
	return evt, true
}

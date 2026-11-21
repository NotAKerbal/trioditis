package signin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

// cdp is a DevTools protocol connection to one Chromium, through the launcher: JSON messages
// over a websocket, with every page's session flattened into the one stream.
type cdp struct {
	ws     *websocket.Conn
	nextID atomic.Int64

	lock    sync.Mutex
	pending map[int64]chan cdpMessage
	// queue holds events not yet taken by events(). It is unbounded so the reader never
	// waits on the session's event loop, which itself waits on replies the reader delivers.
	queue  []cdpMessage
	queued int // bytes in queue
	wake   chan struct{}
	err    error
	closed chan struct{}
}

type cdpMessage struct {
	ID        int64           `json:"id,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`

	size int // bytes, while queued
}

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *cdpError) Error() string { return fmt.Sprintf("devtools error %d: %s", e.Code, e.Message) }

// errClosed is the error of every call once the connection has gone.
var errClosed = errors.New("signin: the browser is gone")

// maxMessage is the largest message taken from Chromium: a screencast frame of a 1600×1200
// viewport at scale 2, base64, or every cookie a page set.
const maxMessage = 32 << 20

// maxQueued bounds the events waiting to be handled, in bytes.
const maxQueued = 128 << 20

func newCDP(ws *websocket.Conn) *cdp {
	ws.SetReadLimit(maxMessage)
	c := &cdp{ws: ws, pending: map[int64]chan cdpMessage{}, wake: make(chan struct{}, 1), closed: make(chan struct{})}
	go c.read()
	return c
}

func (c *cdp) read() {
	var err error
	defer func() { c.close(err) }()
	for {
		var data []byte
		_, data, err = c.ws.Read(context.Background())
		if err != nil {
			return
		}
		var msg cdpMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		c.lock.Lock()
		if msg.ID != 0 {
			if reply, ok := c.pending[msg.ID]; ok {
				delete(c.pending, msg.ID)
				reply <- msg
			}
		} else if msg.Method != "" {
			// A page that makes events faster than they are handled (a stalled viewer, a flood
			// of requests) ends its browser rather than the bridge host's memory.
			if c.queued += len(data); c.queued > maxQueued {
				c.lock.Unlock()
				err = errors.New("signin: the browser's events backed up")
				return
			}
			msg.size = len(data)
			c.queue = append(c.queue, msg)
			select {
			case c.wake <- struct{}{}:
			default:
			}
		}
		c.lock.Unlock()
	}
}

func (c *cdp) close(err error) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if c.err != nil {
		return
	}
	if err == nil {
		err = errClosed
	}
	c.err = err
	for id, reply := range c.pending {
		delete(c.pending, id)
		close(reply)
	}
	close(c.closed)
	// Nothing is left to say to a browser that is going away, so there is no close handshake
	// to wait for.
	_ = c.ws.CloseNow()
}

// next waits for the next event, or returns false once the connection is closed and every
// event before that was taken.
func (c *cdp) next(ctx context.Context) (cdpMessage, bool) {
	for {
		c.lock.Lock()
		if len(c.queue) > 0 {
			msg := c.queue[0]
			c.queued -= msg.size
			c.queue[0] = cdpMessage{}
			c.queue = c.queue[1:]
			c.lock.Unlock()
			return msg, true
		}
		done := c.err != nil
		c.lock.Unlock()
		if done {
			return cdpMessage{}, false
		}
		select {
		case <-c.wake:
		case <-c.closed:
		case <-ctx.Done():
			return cdpMessage{}, false
		}
	}
}

// call sends a method to the browser (session "") or a page's session and decodes its
// result into out, when out isn't nil.
func (c *cdp) call(ctx context.Context, session, method string, params, out any) error {
	id := c.nextID.Add(1)
	msg := map[string]any{"id": id, "method": method}
	if session != "" {
		msg["sessionId"] = session
	}
	if params != nil {
		msg["params"] = params
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	reply := make(chan cdpMessage, 1)
	c.lock.Lock()
	if c.err != nil {
		c.lock.Unlock()
		return errClosed
	}
	c.pending[id] = reply
	c.lock.Unlock()
	if err = c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		c.lock.Lock()
		delete(c.pending, id)
		c.lock.Unlock()
		return err
	}
	select {
	case res, ok := <-reply:
		if !ok {
			return errClosed
		} else if res.Error != nil {
			return res.Error
		} else if out != nil && len(res.Result) > 0 {
			return json.Unmarshal(res.Result, out)
		}
		return nil
	case <-ctx.Done():
		c.lock.Lock()
		delete(c.pending, id)
		c.lock.Unlock()
		return ctx.Err()
	}
}

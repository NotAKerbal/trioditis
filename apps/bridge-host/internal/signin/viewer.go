package signin

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"sync"
	"unicode/utf8"

	"github.com/coder/websocket"
)

// viewer is the person watching a browser, over the websocket the gateway relays
// (docs/architecture/signin-browser.md, Viewer messages).
type viewer struct {
	b      *Browser
	ws     *websocket.Conn
	frames chan frame
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func newViewer(b *Browser, ws *websocket.Conn) *viewer {
	ctx, cancel := context.WithCancel(b.ctx)
	return &viewer{b: b, ws: ws, frames: make(chan frame, 1), ctx: ctx, cancel: cancel}
}

func writeJSON(ctx context.Context, ws *websocket.Conn, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	_ = ws.Write(ctx, websocket.MessageText, data)
}

func (v *viewer) send(msg any) {
	writeJSON(v.ctx, v.ws, msg)
}

// frame queues a screencast frame, or reports false when one is still on its way: the
// browser then acknowledges this one at once and sends the next when the page changes.
func (v *viewer) frame(f frame) bool {
	select {
	case v.frames <- f:
		return true
	default:
		return false
	}
}

func (v *viewer) close() {
	v.once.Do(func() {
		v.cancel()
		_ = v.ws.Close(websocket.StatusNormalClosure, "")
	})
}

// run sends frames and takes input until the viewer leaves or the browser ends.
func (v *viewer) run(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-ctx.Done():
		case <-v.ctx.Done():
		}
		v.close()
	}()
	go v.write()
	for {
		_, data, err := v.ws.Read(v.ctx)
		if err != nil {
			v.close()
			return
		}
		v.input(data)
	}
}

// write sends each frame, then acknowledges it, so Chromium sends no faster than the viewer
// takes them.
func (v *viewer) write() {
	for {
		select {
		case <-v.ctx.Done():
			for {
				select {
				case f := <-v.frames:
					v.b.ack(f)
				default:
					return
				}
			}
		case f := <-v.frames:
			data, err := decodeFrame(f.data)
			if err == nil {
				// Four bytes of the page's generation, big-endian, then the JPEG.
				data = append(binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(data)), f.gen), data...)
				ctx, cancel := context.WithTimeout(v.ctx, writeTimeout)
				err = v.ws.Write(ctx, websocket.MessageBinary, data)
				cancel()
			}
			v.b.ack(f)
			if err != nil && v.ctx.Err() == nil {
				v.close()
			}
		}
	}
}

type viewerInput struct {
	Type       string  `json:"type"`
	Event      string  `json:"event"`
	Width      float64 `json:"width"`
	Height     float64 `json:"height"`
	Scale      float64 `json:"scale"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Button     string  `json:"button"`
	Buttons    int     `json:"buttons"`
	ClickCount int     `json:"clickCount"`
	DeltaX     float64 `json:"deltaX"`
	DeltaY     float64 `json:"deltaY"`
	Modifiers  int     `json:"modifiers"`
	Key        string  `json:"key"`
	Code       string  `json:"code"`
	KeyCode    int     `json:"keyCode"`
	Text       string  `json:"text"`
	Action     string  `json:"action"`
	// Gen is the generation of the frame the viewer was showing.
	Gen uint32 `json:"gen"`
}

var (
	mouseEvents = map[string]bool{"mousePressed": true, "mouseReleased": true, "mouseMoved": true, "mouseWheel": true}
	buttons     = map[string]bool{"none": true, "left": true, "middle": true, "right": true}
	keyEvents   = map[string]bool{"keyDown": true, "rawKeyDown": true, "keyUp": true}
)

const maxText = 4096

func clamp(value, low, high float64) float64 {
	if math.IsNaN(value) {
		return low
	}
	return math.Max(low, math.Min(high, value))
}

// input passes one message from the viewer to the shown page. Anything not in the protocol
// is ignored.
func (v *viewer) input(data []byte) {
	var in viewerInput
	if json.Unmarshal(data, &in) != nil {
		return
	}
	b := v.b
	b.lock.Lock()
	conn, p, view := b.conn, b.active(), b.view
	var gen uint32
	if p != nil {
		gen = p.gen
	}
	b.lock.Unlock()
	if conn == nil || p == nil {
		return
	}
	ctx, cancel := context.WithTimeout(v.ctx, callTimeout)
	defer cancel()
	modifiers := in.Modifiers & 0b1111
	// Pointer and keyboard input goes only to the document whose frame the person saw: across
	// a navigation or a pop-up, what they type for one page mustn't reach the next.
	if (in.Type == "mouse" || in.Type == "key" || in.Type == "text") && in.Gen != gen {
		return
	}
	switch in.Type {
	case "viewport":
		b.resize(viewport{
			Width:  int(clamp(in.Width, 320, 1600)),
			Height: int(clamp(in.Height, 320, 1200)),
			Scale:  math.Round(clamp(in.Scale, 1, 2)*100) / 100,
		}, v)
	case "mouse":
		if !mouseEvents[in.Event] {
			return
		}
		button := in.Button
		if !buttons[button] {
			button = "none"
		}
		params := map[string]any{
			"type": in.Event, "x": clamp(in.X, 0, float64(view.Width)), "y": clamp(in.Y, 0, float64(view.Height)),
			"button": button, "buttons": in.Buttons & 0b11111, "clickCount": int(clamp(float64(in.ClickCount), 0, 3)),
			"modifiers": modifiers,
		}
		if in.Event == "mouseWheel" {
			params["deltaX"], params["deltaY"] = clamp(in.DeltaX, -5000, 5000), clamp(in.DeltaY, -5000, 5000)
		}
		_ = conn.call(ctx, p.session, "Input.dispatchMouseEvent", params, nil)
	case "key":
		if !keyEvents[in.Event] || len(in.Key) > 32 || len(in.Code) > 32 || utf8.RuneCountInString(in.Text) > 1 {
			return
		}
		params := map[string]any{
			"type": in.Event, "key": in.Key, "code": in.Code, "modifiers": modifiers,
			"windowsVirtualKeyCode": int(clamp(float64(in.KeyCode), 0, 255)),
			"nativeVirtualKeyCode":  int(clamp(float64(in.KeyCode), 0, 255)),
		}
		if in.Text != "" {
			params["text"], params["unmodifiedText"] = in.Text, in.Text
		}
		_ = conn.call(ctx, p.session, "Input.dispatchKeyEvent", params, nil)
	case "text":
		if in.Text == "" || utf8.RuneCountInString(in.Text) > maxText {
			return
		}
		_ = conn.call(ctx, p.session, "Input.insertText", map[string]any{"text": in.Text}, nil)
	case "navigate":
		switch in.Action {
		case "reload":
			_ = conn.call(ctx, p.session, "Page.reload", nil, nil)
		case "back", "forward":
			var history struct {
				CurrentIndex int `json:"currentIndex"`
				Entries      []struct {
					ID int `json:"id"`
				} `json:"entries"`
			}
			if conn.call(ctx, p.session, "Page.getNavigationHistory", nil, &history) != nil {
				return
			}
			to := history.CurrentIndex - 1
			if in.Action == "forward" {
				to = history.CurrentIndex + 1
			}
			if to >= 0 && to < len(history.Entries) {
				_ = conn.call(ctx, p.session, "Page.navigateToHistoryEntry", map[string]any{"entryId": history.Entries[to].ID}, nil)
			}
		}
	}
}

// resize applies a viewer's viewport to every page and restarts the screencast at its size.
func (b *Browser) resize(view viewport, v *viewer) {
	b.lock.Lock()
	if b.view == view {
		b.lock.Unlock()
		v.send(map[string]any{"type": "viewport", "width": view.Width, "height": view.Height, "scale": view.Scale})
		return
	}
	b.view = view
	conn, pages := b.conn, slices_clone(b.pages)
	b.lock.Unlock()
	ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
	defer cancel()
	for _, p := range pages {
		_ = conn.call(ctx, p.session, "Emulation.setDeviceMetricsOverride", metrics(view), nil)
	}
	v.send(map[string]any{"type": "viewport", "width": view.Width, "height": view.Height, "scale": view.Scale})
	b.unshow()
	b.show()
}

func slices_clone(pages []*page) []*page {
	return append([]*page(nil), pages...)
}

package signin

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
)

// A sign-in page that, once its button is clicked, signs in: it sets cookies, stores a value,
// makes the request the step reads a header and a body field from, and goes to /home.
const signinPage = `<!doctype html><title>Signed out</title>
<button id="go" style="position:fixed;inset:0;width:100%;height:100%">Sign in</button>
<script>
document.getElementById('go').onclick = async () => {
  localStorage.setItem('ls_key', 'from-storage')
  await fetch('/api/boot', { method: 'POST', headers: { 'X-Test': 'header-value', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=xoxc-body' })
  location.href = '/login'
}
</script>`

func findTestChromium(t *testing.T) string {
	for _, name := range []string{os.Getenv("CHROMIUM_PATH"), "chromium", "chromium-browser", "google-chrome-stable", "google-chrome"} {
		if name == "" {
			continue
		}
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	t.Skip("no Chromium on PATH (set CHROMIUM_PATH)")
	return ""
}

func freeAddr(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

// startLauncher builds and runs cmd/login-browser, as compose does, and returns its URL.
func startLauncher(t *testing.T, chromium string) string {
	bin := filepath.Join(t.TempDir(), "login-browser")
	// The go that runs this test, which may not be on PATH.
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, "../../cmd/login-browser")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build login-browser: %v\n%s", err, out)
	}
	addr := freeAddr(t)
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(), "LOGIN_BROWSER_TOKEN=test-token", "LOGIN_BROWSER_ADDR="+addr,
		"CHROMIUM_PATH="+chromium, "LOGIN_BROWSER_TMP="+t.TempDir())
	if os.Getuid() == 0 {
		cmd.Env = append(cmd.Env, "LOGIN_BROWSER_NO_SANDBOX=1")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	for range 100 {
		if resp, err := http.Get("http://" + addr + "/v1/health"); err == nil {
			resp.Body.Close()
			return "http://" + addr
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("login-browser didn't start")
	return ""
}

func TestBrowserSignsIn(t *testing.T) {
	var boots atomic.Int32
	chromium := ""
	if os.Getenv("LOGIN_BROWSER_TEST_URL") == "" {
		chromium = findTestChromium(t)
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, signinPage)
		case "/api/boot":
			boots.Add(1)
			w.WriteHeader(http.StatusNoContent)
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "xs", Value: "abc%3Adef", Path: "/"})
			http.SetCookie(w, &http.Cookie{Name: "c_user", Value: "42", Path: "/"})
			http.Redirect(w, r, "/home", http.StatusFound)
		case "/home":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><title>Home</title><p>Signed in`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()

	// The test site is on loopback, which the egress proxy otherwise refuses.
	plan := &EgressPlan{Bind: "127.0.0.1", allowed: func(netip.Addr) bool { return true }, allowedPort: func(string) bool { return true }}
	// LOGIN_BROWSER_TEST_URL runs the test against a launcher already running, such as the
	// login-browser image on the host's network, with LOGIN_BROWSER_TOKEN=test-token.
	launcherURL := os.Getenv("LOGIN_BROWSER_TEST_URL")
	if launcherURL == "" {
		launcherURL = startLauncher(t, chromium)
	}
	launcher := &Launcher{URL: launcherURL, Token: "test-token", Egress: plan, Log: zerolog.Nop()}

	params := &bridgev2.LoginCookiesParams{
		URL:               site.URL + "/",
		WaitForURLPattern: `/home$`,
		ExtractJS:         `Promise.resolve({ title: document.title })`,
		Fields: []bridgev2.LoginCookieField{
			{ID: "xs", Required: true, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "xs", CookieDomain: "127.0.0.1"}}},
			{ID: "c_user", Required: true, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "c_user"}}},
			{ID: "header", Required: true, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeRequestHeader, Name: "X-Test", RequestURLRegex: `/api/`}}},
			{ID: "cookie_header", Required: true, Pattern: `\bxs=`, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeRequestHeader, Name: "Cookie", RequestURLRegex: `/home`}}},
			{ID: "token", Required: true, Pattern: `^xoxc-`, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeRequestBody, Name: "token", RequestURLRegex: `/api/boot$`}}},
			{ID: "stored", Required: true, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeLocalStorage, Name: "ls_key"}}},
			{ID: "title", Required: true, Pattern: `^Home$`, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeSpecial, Name: "title"}}},
			{ID: "missing", Required: false, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "nope"}}},
		},
	}
	submitted := make(chan map[string]string, 1)
	b := launcher.New(params, Owner("user_a"), func(values map[string]string) { submitted <- values }, func(err error) { t.Errorf("failed: %v", err) })
	defer b.Close()

	// The viewer's side, as the gateway relays it.
	viewerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		_ = b.Watch(r.Context(), ws)
	}))
	defer viewerServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(viewerServer.URL, "http", "ws", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxMessage)
	send := func(msg any) {
		data, _ := json.Marshal(msg)
		if err := ws.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	send(map[string]any{"type": "viewport", "width": 800, "height": 600, "scale": 1})

	var sawFrame, sawPage, clicked, done bool
	var gen uint32
	for !done {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("viewer: %v (frame %v, page %v, clicked %v)", err, sawFrame, sawPage, clicked)
		}
		if kind == websocket.MessageBinary {
			// The page's generation, then the JPEG.
			if len(data) < 6 || !bytes.HasPrefix(data[4:], []byte{0xff, 0xd8}) {
				t.Fatal("a frame isn't a generation and a JPEG")
			}
			gen = binary.BigEndian.Uint32(data)
			sawFrame = true
		} else {
			var msg struct {
				Type, URL string
				Loading   bool
			}
			_ = json.Unmarshal(data, &msg)
			switch msg.Type {
			case "page":
				if strings.HasPrefix(msg.URL, site.URL) && !msg.Loading {
					sawPage = true
				}
			case "done":
				done = true
			case "error":
				t.Fatalf("browser error: %s", data)
			}
		}
		if sawFrame && sawPage && !clicked {
			clicked = true
			click := func(g uint32) {
				for _, event := range []string{"mousePressed", "mouseReleased"} {
					send(map[string]any{"type": "mouse", "event": event, "x": 400, "y": 300, "button": "left", "buttons": 1, "clickCount": 1, "gen": g})
				}
			}
			// A click for a page the viewer didn't see goes nowhere.
			click(gen + 1000)
			time.Sleep(1500 * time.Millisecond)
			if boots.Load() != 0 {
				t.Fatal("a click for another page's generation reached this one")
			}
			// The one for this page signs in.
			click(gen)
		}
	}

	select {
	case values := <-submitted:
		want := map[string]string{
			"xs": "abc:def", "c_user": "42", "header": "header-value", "token": "xoxc-body",
			"stored": "from-storage", "title": "Home",
		}
		for id, value := range want {
			if values[id] != value {
				t.Errorf("%s = %q, want %q", id, values[id], value)
			}
		}
		if !strings.Contains(values["cookie_header"], "c_user=42") {
			t.Errorf("cookie_header = %q, want the cookies sent to /home", values["cookie_header"])
		}
		if _, ok := values["missing"]; ok {
			t.Error("a field with no value was submitted")
		}
	case <-ctx.Done():
		t.Fatal("nothing was submitted")
	}
	if !b.Closed() {
		t.Error("the browser is still open after submitting")
	}
}

// passkeyClicks is how many clicks the passkey page needs, a quarter of a second apart, as
// its script counts them.
const passkeyClicks = 12

// A sign-in page that asks for a passkey as it loads, as Google's does, and signs in by
// another way once its button has had every click, abandoning the request as Google's "Try
// another way" does. Without virtual authenticators, headless Chromium stops taking input
// about half a second into the request, so the clicks are spread over three seconds. The
// login-browser image's Chromium does this every time (run it with LOGIN_BROWSER_TEST_URL);
// Google Chrome on a desktop, run as the launcher runs it, may not.
const passkeyPage = `<!doctype html><title>Verifying it's you</title>
<button id="other" style="position:fixed;inset:0;width:100%;height:100%">Try another way</button>
<script>
const asking = new AbortController()
navigator.credentials.get({ signal: asking.signal, publicKey: { challenge: new Uint8Array(32), allowCredentials: [], userVerification: 'preferred', timeout: 120000 } }).catch(() => {})
let clicks = 0
document.getElementById('other').onclick = () => {
  if (++clicks < 12) return
  asking.abort()
  location.href = '/login'
}
</script>`

func TestBrowserPasskey(t *testing.T) {
	chromium := ""
	if os.Getenv("LOGIN_BROWSER_TEST_URL") == "" {
		chromium = findTestChromium(t)
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, passkeyPage)
		case "/login":
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "signed-in", Path: "/"})
			http.Redirect(w, r, "/home", http.StatusFound)
		case "/home":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><title>Home</title><p>Signed in`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()
	// A passkey needs a name, not an address, for its site: on 127.0.0.1 the request fails at once.
	siteURL := strings.Replace(site.URL, "127.0.0.1", "localhost", 1)

	plan := &EgressPlan{Bind: "127.0.0.1", allowed: func(netip.Addr) bool { return true }, allowedPort: func(string) bool { return true }}
	launcherURL := os.Getenv("LOGIN_BROWSER_TEST_URL")
	if launcherURL == "" {
		launcherURL = startLauncher(t, chromium)
	}
	launcher := &Launcher{URL: launcherURL, Token: "test-token", Egress: plan, Log: zerolog.Nop()}
	params := &bridgev2.LoginCookiesParams{
		URL:               siteURL + "/",
		WaitForURLPattern: `/home$`,
		Fields: []bridgev2.LoginCookieField{
			{ID: "sid", Required: true, Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "sid"}}},
		},
	}
	submitted := make(chan map[string]string, 1)
	b := launcher.New(params, Owner("user_a"), func(values map[string]string) { submitted <- values }, func(err error) { t.Errorf("failed: %v", err) })
	defer b.Close()

	viewerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		_ = b.Watch(r.Context(), ws)
	}))
	defer viewerServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, strings.Replace(viewerServer.URL, "http", "ws", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxMessage)
	send := func(msg any) {
		data, _ := json.Marshal(msg)
		if err := ws.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	send(map[string]any{"type": "viewport", "width": 800, "height": 600, "scale": 1})

	// Clicked from once the page has loaded and drawn, with its passkey request waiting.
	var sawFrame, sawPage, clicked, done bool
	var gen uint32
	for !done {
		kind, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("viewer: %v (frame %v, page %v, clicked %v)", err, sawFrame, sawPage, clicked)
		}
		if kind == websocket.MessageBinary {
			gen = binary.BigEndian.Uint32(data)
			sawFrame = true
		} else {
			var msg struct {
				Type, URL string
				Loading   bool
			}
			_ = json.Unmarshal(data, &msg)
			switch msg.Type {
			case "page":
				if strings.HasPrefix(msg.URL, siteURL) && !msg.Loading {
					sawPage = true
				}
			case "done":
				done = true
			case "error":
				t.Fatalf("browser error: %s", data)
			}
		}
		if sawFrame && sawPage && !clicked {
			clicked = true
			for range passkeyClicks {
				time.Sleep(250 * time.Millisecond)
				for _, event := range []string{"mousePressed", "mouseReleased"} {
					send(map[string]any{"type": "mouse", "event": event, "x": 400, "y": 300, "button": "left", "buttons": 1, "clickCount": 1, "gen": gen})
				}
			}
		}
	}
	select {
	case values := <-submitted:
		if values["sid"] != "signed-in" {
			t.Errorf("sid = %q, want signed-in", values["sid"])
		}
	case <-ctx.Done():
		t.Fatal("nothing was submitted")
	}
}

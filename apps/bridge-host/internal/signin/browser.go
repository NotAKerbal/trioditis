// Package signin runs the sign-in browser: a Chromium on the server, shown live to the
// person in the login stepper, from which the bridge host collects what a network's cookie
// login step needs. See docs/architecture/signin-browser.md.
package signin

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
)

// Launcher is where a bridge host gets its sign-in browsers: the login-browser service.
type Launcher struct {
	// URL is the launcher's address, ws:// or http://.
	URL   string
	Token string
	// Egress gives each browser the proxy it reaches the web through.
	Egress *EgressPlan
	Log    zerolog.Logger
}

const (
	// idleLimit is how long a browser nobody watches stays open, for a viewer that lost its
	// connection or reloaded the page.
	idleLimit = 2 * time.Minute
	// lifetime is the longest a browser stays open; the launcher enforces it too.
	lifetime = 20 * time.Minute
	// hiddenLimit is how long a step that runs by itself may take.
	hiddenLimit = 3 * time.Minute
	// settle is how long a browser waits once it has everything before it submits, so the
	// requests a page makes right after signing in are seen too.
	settle = 1500 * time.Millisecond
	// checkEvery is how often the browser looks for the values without anything prompting it.
	checkEvery   = 2 * time.Second
	callTimeout  = 15 * time.Second
	writeTimeout = 10 * time.Second
)

// Browser is one cookie login step's sign-in browser. It starts when the first viewer comes,
// or straight away for a hidden step, and ends when it has submitted, when it's closed, or
// when nobody has watched it for idleLimit.
type Browser struct {
	launcher *Launcher
	params   *bridgev2.LoginCookiesParams
	owner    string
	submit   func(map[string]string)
	fail     func(error)
	log      zerolog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	startOnce sync.Once
	started   chan struct{}
	startErr  error

	lock        sync.Mutex
	conn        *cdp
	closeEgress func()
	ua          userAgent
	pages       []*page // the last is the one shown
	view        viewport
	viewer      *viewer
	col         *collector
	ready       time.Time // when everything was first found
	idle        *time.Timer
	finished    bool
	requests    map[string]*request // by CDP request ID
	// closedTargets holds the pages Chromium has said are gone; settingUp, pages being set up,
	// by session.
	closedTargets map[string]bool
	settingUp     map[string]*page
	// requestBytes is about how much requests holds; bodyReads, the bodies being fetched.
	requestBytes int
	// gen is the last page generation handed out.
	gen       uint32
	bodyReads chan struct{}
	check     chan struct{}
}

type page struct {
	target  string
	session string
	frame   string // the main frame's ID
	url     string
	loading bool
	// shown says the page's screencast is running.
	shown bool
	// gen identifies the document the page shows, unique across the browser's pages: it
	// changes whenever the main frame navigates. Frames carry it and input must name it, so
	// what the person types goes only to the page they saw (Viewer messages).
	gen uint32
}

type request struct {
	url     string
	headers map[string]string
	body    string
	// extra holds the headers actually sent (cookies included), which can arrive before the
	// request itself.
	extra map[string]string
	// hop counts the request's redirects, which reuse its ID: a body fetched for one hop
	// isn't the next one's.
	hop int
}

type viewport struct {
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  float64 `json:"scale"`
}

type userAgent struct {
	value    string
	metadata map[string]any
}

// New makes the browser for a cookie step. submit gets what was collected, once, after the
// browser has closed; fail is called if a hidden step's browser can't finish.
// owner is whose browser it is (Owner), for the launcher's limit on each person's browsers.
func (l *Launcher) New(params *bridgev2.LoginCookiesParams, owner string, submit func(map[string]string), fail func(error)) *Browser {
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	return &Browser{
		launcher: l, params: params, owner: owner, submit: submit, fail: fail, log: l.Log,
		ctx: ctx, cancel: cancel, started: make(chan struct{}),
		view:          viewport{Width: 1024, Height: 720, Scale: 1},
		col:           newCollector(params),
		requests:      map[string]*request{},
		closedTargets: map[string]bool{},
		settingUp:     map[string]*page{},
		bodyReads:     make(chan struct{}, maxBodyReads),
		check:         make(chan struct{}, 1),
	}
}

// Hidden says the step runs by itself, with nobody watching.
func (b *Browser) Hidden() bool { return b.params.Hidden }

// Run starts a hidden step's browser and gives it hiddenLimit to finish.
func (b *Browser) Run() {
	go func() {
		if err := b.start(); err != nil {
			b.failed(err)
			return
		}
		select {
		case <-b.ctx.Done():
		case <-time.After(hiddenLimit):
			b.failed(errors.New("signin: the step didn't finish in time"))
		}
	}()
}

func (b *Browser) failed(err error) {
	b.lock.Lock()
	over := b.finished
	b.finished = true
	b.lock.Unlock()
	b.Close()
	// A browser someone watches only closes: they can open another, or paste instead. A hidden
	// step's has nobody to do that, so its login can't go on.
	if !over && b.fail != nil && b.params.Hidden {
		b.fail(err)
	}
}

// Closed says the browser has ended; a later viewer needs a new one.
func (b *Browser) Closed() bool {
	return b.ctx.Err() != nil
}

// Close ends the browser: Chromium is killed and its profile removed by the launcher once
// the connection goes.
func (b *Browser) Close() {
	b.cancel()
	b.lock.Lock()
	defer b.lock.Unlock()
	if b.conn != nil {
		b.conn.close(nil)
	}
	if b.closeEgress != nil {
		b.closeEgress()
		b.closeEgress = nil
	}
	if b.idle != nil {
		b.idle.Stop()
	}
	if b.viewer != nil {
		b.viewer.close()
		b.viewer = nil
	}
	b.col.wipe()
	clear(b.requests)
}

func (b *Browser) start() error {
	b.startOnce.Do(func() {
		b.startErr = b.launch()
		close(b.started)
		if b.startErr != nil {
			b.Close()
		}
	})
	<-b.started
	return b.startErr
}

func (b *Browser) launch() error {
	proxy, closeEgress, err := b.launcher.Egress.Open()
	if err != nil {
		return err
	}
	// Closed by whichever of this and Close gets to it.
	closeEgress = sync.OnceFunc(closeEgress)
	b.lock.Lock()
	b.closeEgress = closeEgress
	b.lock.Unlock()
	// A browser closed meanwhile has already looked for a proxy to close.
	if b.ctx.Err() != nil {
		closeEgress()
		return b.ctx.Err()
	}
	query := url.Values{"proxy": {proxy}, "owner": {b.owner}}
	if b.params.UserAgent != "" {
		query.Set("ua", b.params.UserAgent)
	}
	address := strings.Replace(strings.TrimRight(b.launcher.URL, "/"), "http", "ws", 1) + "/v1/browser?" + query.Encode()
	ctx, cancel := context.WithTimeout(b.ctx, 30*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, address, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + b.launcher.Token}},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
			return ErrOwnerBusy
		}
		return err
	}
	conn := newCDP(ws)
	b.lock.Lock()
	b.conn = conn
	b.lock.Unlock()
	go b.events(conn)
	go b.checker()

	var version struct {
		Product   string `json:"product"`
		UserAgent string `json:"userAgent"`
	}
	if err = conn.call(ctx, "", "Browser.getVersion", nil, &version); err != nil {
		return err
	}
	b.ua = makeUserAgent(b.params.UserAgent, version.UserAgent)
	if err = conn.call(ctx, "", "Browser.setDownloadBehavior", map[string]any{"behavior": "deny"}, nil); err != nil {
		return err
	}
	if err = conn.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil); err != nil {
		return err
	}
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err = conn.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return err
	}
	p, err := b.attach(ctx, created.TargetID)
	if err != nil {
		return err
	}
	return conn.call(ctx, p.session, "Page.navigate", map[string]any{"url": b.params.URL}, nil)
}

var chromeVersion = regexp.MustCompile(`(?:Headless)?Chrome/(\d+)\.(\d+\.\d+\.\d+)`)

// makeUserAgent is the user agent pages see: the step's, or this Chromium's own without the
// "Headless" a site would turn it away for, with client hints that agree with it.
func makeUserAgent(want, own string) userAgent {
	value := want
	if value == "" {
		value = strings.Replace(own, "HeadlessChrome/", "Chrome/", 1)
	}
	major, full := "140", "140.0.0.0"
	if m := chromeVersion.FindStringSubmatch(value); m != nil {
		major, full = m[1], m[1]+"."+m[2]
	}
	platform := "Linux"
	switch {
	case strings.Contains(value, "Windows"):
		platform = "Windows"
	case strings.Contains(value, "Macintosh"):
		platform = "macOS"
	}
	brands := []map[string]string{
		{"brand": "Chromium", "version": major}, {"brand": "Google Chrome", "version": major},
		{"brand": "Not_A Brand", "version": "24"},
	}
	fullBrands := []map[string]string{
		{"brand": "Chromium", "version": full}, {"brand": "Google Chrome", "version": full},
		{"brand": "Not_A Brand", "version": "24.0.0.0"},
	}
	return userAgent{value: value, metadata: map[string]any{
		"brands": brands, "fullVersionList": fullBrands, "fullVersion": full, "platform": platform,
		"platformVersion": "", "architecture": "x86", "model": "", "mobile": false, "bitness": "64",
	}}
}

// attach takes control of a page: it is set up to look like an ordinary browser's, shown
// from then on, and watched for what the step needs.
func (b *Browser) attach(ctx context.Context, target string) (*page, error) {
	b.lock.Lock()
	conn, view := b.conn, b.view
	b.lock.Unlock()
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := conn.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target, "flatten": true}, &attached); err != nil {
		return nil, err
	}
	session := attached.SessionID
	// Known before its events start, so a page that navigates while it's being set up (a
	// pop-up that loads fast) has its address recorded; it's shown only once set up.
	b.lock.Lock()
	b.gen++
	p := &page{target: target, session: session, loading: true, gen: b.gen}
	b.settingUp[session] = p
	b.lock.Unlock()
	defer func() {
		b.lock.Lock()
		delete(b.settingUp, session)
		b.lock.Unlock()
	}()
	for _, step := range []struct {
		method string
		params any
	}{
		{"Network.setUserAgentOverride", map[string]any{
			"userAgent": b.ua.value, "acceptLanguage": "en-US,en", "platform": b.ua.metadata["platform"],
			"userAgentMetadata": b.ua.metadata,
		}},
		{"Page.enable", nil},
		// Request bodies up to this size come with the request, for fields read from one.
		{"Network.enable", map[string]any{"maxPostDataSize": maxValue}},
		// A file chooser would offer the server's files; it never opens.
		{"Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}},
		// Without focus a headless page draws no caret and some sites' fields never react.
		{"Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true}},
		// A passkey request (Google's "Verifying it's you") otherwise opens a prompt headless
		// Chromium never shows, and until it ends the page takes no input and draws nothing.
		// With WebAuthn's virtual authenticators on and none added, the request just waits, so
		// the person can choose another way to sign in, and no passkey can be made here.
		{"WebAuthn.enable", map[string]any{"enableUI": false}},
		{"Emulation.setDeviceMetricsOverride", metrics(view)},
	} {
		if err := conn.call(ctx, session, step.method, step.params, nil); err != nil {
			return nil, err
		}
	}
	// What it shows already, in case that was decided before its events were on.
	var tree struct {
		FrameTree struct {
			Frame struct {
				ID  string `json:"id"`
				URL string `json:"url"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := conn.call(ctx, session, "Page.getFrameTree", nil, &tree); err != nil {
		return nil, err
	}
	b.lock.Lock()
	if p.frame == "" {
		p.frame, p.url = tree.FrameTree.Frame.ID, tree.FrameTree.Frame.URL
	}
	// A pop-up that closed while it was being set up never becomes the page shown.
	if b.closedTargets[target] {
		b.lock.Unlock()
		return nil, errors.New("signin: the page closed")
	}
	b.pages = append(b.pages, p)
	b.lock.Unlock()
	b.show()
	return p, nil
}

func metrics(v viewport) map[string]any {
	return map[string]any{"width": v.Width, "height": v.Height, "deviceScaleFactor": v.Scale, "mobile": false}
}

// active is the page shown, or nil.
func (b *Browser) active() *page {
	if len(b.pages) == 0 {
		return nil
	}
	return b.pages[len(b.pages)-1]
}

// show makes the screencast follow the shown page and the viewer, and tells the viewer
// where it is.
func (b *Browser) show() {
	b.lock.Lock()
	conn, view, v, shown := b.conn, b.view, b.viewer, b.active()
	var stop, start []*page
	for _, p := range b.pages {
		want := p == shown && v != nil
		if p.shown && !want {
			stop = append(stop, p)
		} else if !p.shown && want {
			start = append(start, p)
		}
		p.shown = want
	}
	b.lock.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
	defer cancel()
	for _, p := range stop {
		_ = conn.call(ctx, p.session, "Page.stopScreencast", nil, nil)
	}
	for _, p := range start {
		_ = conn.call(ctx, p.session, "Page.startScreencast", map[string]any{
			"format": "jpeg", "quality": 70, "everyNthFrame": 1,
			"maxWidth": int(float64(view.Width) * view.Scale), "maxHeight": int(float64(view.Height) * view.Scale),
		}, nil)
	}
	b.tellPage()
}

func (b *Browser) tellPage() {
	b.lock.Lock()
	v, p := b.viewer, b.active()
	if v == nil || p == nil {
		b.lock.Unlock()
		return
	}
	msg := map[string]any{"type": "page", "url": p.url, "loading": p.loading}
	b.lock.Unlock()
	v.send(msg)
}

func (b *Browser) pageBySession(session string) *page {
	for _, p := range b.pages {
		if p.session == session {
			return p
		}
	}
	return b.settingUp[session]
}

func (b *Browser) poke() {
	select {
	case b.check <- struct{}{}:
	default:
	}
}

// events handles what Chromium reports, in order, until the connection closes.
func (b *Browser) events(conn *cdp) {
	defer func() {
		// A browser that went away by itself (a crash, the launcher's time limit) can't go on.
		if b.ctx.Err() == nil {
			b.lock.Lock()
			v := b.viewer
			b.lock.Unlock()
			if v != nil {
				v.send(map[string]any{"type": "error", "error": "internal"})
			}
			b.failed(errors.New("signin: the browser stopped"))
		}
	}()
	for {
		msg, ok := conn.next(b.ctx)
		if !ok {
			return
		}
		b.handle(conn, msg)
	}
}

func (b *Browser) handle(conn *cdp, msg cdpMessage) {
	switch msg.Method {
	case "Target.targetCreated":
		var params struct {
			TargetInfo struct {
				TargetID string `json:"targetId"`
				Type     string `json:"type"`
				OpenerID string `json:"openerId"`
			} `json:"targetInfo"`
		}
		// A pop-up a page opened (signing in with another account) is shown while it's open.
		if json.Unmarshal(msg.Params, &params) == nil && params.TargetInfo.Type == "page" && params.TargetInfo.OpenerID != "" {
			go func() {
				ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
				defer cancel()
				if p, err := b.attach(ctx, params.TargetInfo.TargetID); err == nil {
					// The pop-up was already on its way when it was attached.
					b.lock.Lock()
					p.loading = false
					b.lock.Unlock()
					b.runScript(p)
				}
			}()
		}
	case "Target.targetDestroyed", "Target.detachedFromTarget":
		var params struct {
			TargetID string `json:"targetId"`
		}
		if json.Unmarshal(msg.Params, &params) != nil || params.TargetID == "" {
			return
		}
		b.lock.Lock()
		if len(b.closedTargets) > maxRequests {
			clear(b.closedTargets)
		}
		b.closedTargets[params.TargetID] = true
		before := len(b.pages)
		b.pages = slices.DeleteFunc(b.pages, func(p *page) bool { return p.target == params.TargetID })
		gone := len(b.pages) == 0 && before > 0
		b.lock.Unlock()
		if gone {
			b.failed(errors.New("signin: the page was closed"))
			return
		}
		b.show()
	case "Page.frameStartedLoading", "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.loadEventFired":
		b.navigation(msg)
	case "Page.javascriptDialogOpening":
		// Nobody can answer a dialog in the stepper; one left open would stop the page.
		go func() {
			ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
			defer cancel()
			_ = conn.call(ctx, msg.SessionID, "Page.handleJavaScriptDialog", map[string]any{"accept": true}, nil)
		}()
	case "Page.screencastFrame":
		var params struct {
			Data      string `json:"data"`
			SessionID int    `json:"sessionId"`
		}
		if json.Unmarshal(msg.Params, &params) != nil {
			return
		}
		b.lock.Lock()
		v, shown := b.viewer, b.active()
		var gen uint32
		if shown != nil {
			gen = shown.gen
		}
		b.lock.Unlock()
		f := frame{session: msg.SessionID, id: params.SessionID, data: params.Data, gen: gen}
		if v == nil || shown == nil || shown.session != msg.SessionID || !v.frame(f) {
			b.ack(f)
		}
	case "Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo":
		b.network(conn, msg)
	case "Network.responseReceivedExtraInfo":
		// A response that sets a cookie may be the one that signs the person in.
		b.poke()
	}
}

func (b *Browser) navigation(msg cdpMessage) {
	var params struct {
		FrameID string `json:"frameId"`
		URL     string `json:"url"`
		Frame   struct {
			ID       string `json:"id"`
			ParentID string `json:"parentId"`
			URL      string `json:"url"`
		} `json:"frame"`
	}
	if json.Unmarshal(msg.Params, &params) != nil {
		return
	}
	b.lock.Lock()
	p := b.pageBySession(msg.SessionID)
	if p == nil {
		b.lock.Unlock()
		return
	}
	loaded := false
	switch msg.Method {
	case "Page.frameStartedLoading":
		if params.FrameID == p.frame || p.frame == "" {
			p.loading = true
		}
	case "Page.frameNavigated":
		if params.Frame.ParentID != "" {
			b.lock.Unlock()
			return
		}
		p.frame, p.url = params.Frame.ID, params.Frame.URL
		b.gen++
		p.gen = b.gen
	case "Page.navigatedWithinDocument":
		if params.FrameID != p.frame {
			b.lock.Unlock()
			return
		}
		p.url = params.URL
	case "Page.loadEventFired":
		p.loading = false
		loaded = true
	}
	b.lock.Unlock()
	if loaded {
		b.runScript(p)
	}
	b.tellPage()
	b.poke()
}

// runScript runs the step's script on a page that has loaded. It resolves once it has found
// what it looks for, which may be long after, or never, on a page it can't read.
func (b *Browser) runScript(p *page) {
	if b.params.ExtractJS == "" {
		return
	}
	b.lock.Lock()
	conn := b.conn
	b.lock.Unlock()
	go func() {
		var result struct {
			Result struct {
				Value map[string]any `json:"value"`
			} `json:"result"`
			ExceptionDetails any `json:"exceptionDetails"`
		}
		err := conn.call(b.ctx, p.session, "Runtime.evaluate", map[string]any{
			"expression": b.params.ExtractJS, "awaitPromise": true, "returnByValue": true,
		}, &result)
		if err != nil || result.ExceptionDetails != nil || result.Result.Value == nil {
			// The page navigated away, or the script gave up; the next load runs it again.
			return
		}
		b.lock.Lock()
		b.col.extract(result.Result.Value)
		b.lock.Unlock()
		b.poke()
	}()
}

// maxRequests and maxRequestBytes bound the requests remembered while their headers and body
// come together; past either, what is remembered is dropped and collecting starts over.
const (
	maxRequests     = 2000
	maxRequestBytes = 16 << 20
	// maxBodyReads bounds the request bodies being fetched from Chromium at once.
	maxBodyReads = 4
)

func (b *Browser) network(conn *cdp, msg cdpMessage) {
	b.lock.Lock()
	wants := b.col.wantsRequests()
	b.lock.Unlock()
	if !wants {
		return
	}
	var params struct {
		RequestID string            `json:"requestId"`
		Headers   map[string]string `json:"headers"`
		Request   struct {
			URL         string            `json:"url"`
			Headers     map[string]string `json:"headers"`
			PostData    string            `json:"postData"`
			HasPostData bool              `json:"hasPostData"`
		} `json:"request"`
	}
	if json.Unmarshal(msg.Params, &params) != nil || params.RequestID == "" {
		return
	}
	b.lock.Lock()
	if len(b.requests) > maxRequests || b.requestBytes > maxRequestBytes {
		clear(b.requests)
		b.requestBytes = 0
	}
	req := b.requests[params.RequestID]
	if req == nil {
		req = &request{}
		b.requests[params.RequestID] = req
	}
	fetchBody := false
	if msg.Method == "Network.requestWillBeSent" {
		// A redirect is sent again under the same ID, to a new address. Only a body a field is
		// read from is kept, and only as much of it as a field could be.
		wantsBody := b.col.wantsBody(params.Request.URL)
		if req.url != "" {
			// A redirect: the headers sent for the last hop aren't this one's.
			req.extra = nil
		}
		req.url, req.headers, req.body = params.Request.URL, params.Request.Headers, ""
		req.hop++
		if wantsBody {
			req.body = truncate(params.Request.PostData, maxValue)
		}
		fetchBody = wantsBody && req.body == "" && params.Request.HasPostData && len(b.bodyReads) < maxBodyReads
		if fetchBody {
			b.bodyReads <- struct{}{}
		}
	} else {
		req.extra = params.Headers
	}
	b.requestBytes += len(msg.Params)
	hop := req.hop
	b.record(req)
	b.lock.Unlock()
	if fetchBody {
		go func() {
			defer func() { <-b.bodyReads }()
			ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
			defer cancel()
			var body struct {
				PostData string `json:"postData"`
			}
			if conn.call(ctx, msg.SessionID, "Network.getRequestPostData", map[string]any{"requestId": params.RequestID}, &body) == nil {
				kept := truncate(body.PostData, maxValue)
				body.PostData = ""
				b.lock.Lock()
				// A request dropped or replaced meanwhile keeps nothing of it.
				if b.requests[params.RequestID] == req && req.hop == hop {
					req.body = kept
					b.requestBytes += len(kept)
					b.record(req)
				}
				b.lock.Unlock()
				b.poke()
			}
		}()
	}
}

// truncate keeps at most n bytes of value, in its own copy: a slice of a long body would
// keep all of it in memory.
func truncate(value string, n int) string {
	if len(value) > n {
		return strings.Clone(value[:n])
	}
	return value
}

// record passes a request to the collector once its address is known. Called with b.lock.
func (b *Browser) record(req *request) {
	if req.url == "" {
		return
	}
	headers := map[string]string{}
	for name, value := range req.headers {
		headers[name] = value
	}
	for name, value := range req.extra {
		headers[name] = value
	}
	b.col.request(req.url, headers, req.body)
}

// checker looks for the values whenever something may have changed, and every checkEvery,
// and submits them once there is everything.
func (b *Browser) checker() {
	ticker := time.NewTicker(checkEvery)
	defer ticker.Stop()
	for {
		select {
		case <-b.ctx.Done():
			return
		case <-ticker.C:
		case <-b.check:
		}
		values, complete := b.collect()
		if !complete {
			b.lock.Lock()
			b.ready = time.Time{}
			b.lock.Unlock()
			clear(values)
			continue
		}
		b.lock.Lock()
		if b.ready.IsZero() {
			b.ready = time.Now()
			b.lock.Unlock()
			clear(values)
			time.AfterFunc(settle, b.poke)
			continue
		} else if time.Since(b.ready) < settle {
			b.lock.Unlock()
			clear(values)
			continue
		}
		over := b.finished
		b.finished = true
		v := b.viewer
		b.lock.Unlock()
		if over {
			clear(values)
			return
		}
		if v != nil {
			v.send(map[string]any{"type": "done"})
		}
		b.Close()
		b.submit(values)
		return
	}
}

func (b *Browser) collect() (map[string]string, bool) {
	b.lock.Lock()
	conn, p := b.conn, b.active()
	keys := b.col.localStorageKeys()
	b.lock.Unlock()
	if conn == nil || p == nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
	defer cancel()
	var jar struct {
		Cookies []cookie `json:"cookies"`
	}
	if err := conn.call(ctx, "", "Storage.getCookies", nil, &jar); err != nil {
		return nil, false
	}
	local := map[string]string{}
	if len(keys) > 0 {
		encoded, _ := json.Marshal(keys)
		var result struct {
			Result struct {
				Value map[string]string `json:"value"`
			} `json:"result"`
		}
		// A page whose storage can't be read (about:blank, a sandboxed frame) has none of it.
		if conn.call(ctx, p.session, "Runtime.evaluate", map[string]any{
			"expression":    "(() => { try { return Object.fromEntries(" + string(encoded) + ".map(k => [k, localStorage.getItem(k) ?? ''])) } catch { return {} } })()",
			"returnByValue": true,
		}, &result) == nil && result.Result.Value != nil {
			local = result.Result.Value
		}
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	values, complete := b.col.collect(jar.Cookies, local, p.url)
	for i := range jar.Cookies {
		jar.Cookies[i].Value = ""
	}
	clear(local)
	return values, complete
}

type frame struct {
	session string
	id      int
	data    string
	gen     uint32
}

func (b *Browser) ack(f frame) {
	b.lock.Lock()
	conn := b.conn
	b.lock.Unlock()
	if conn == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
		defer cancel()
		_ = conn.call(ctx, f.session, "Page.screencastFrameAck", map[string]any{"sessionId": f.id}, nil)
	}()
}

// ErrOwnerBusy is the error for a browser whose person already has as many as the launcher
// runs for one person.
var ErrOwnerBusy = errors.New("signin: that person already has a sign-in browser open")

// Owner is the launcher's name for a person: it needs to tell people apart, not who they are.
func Owner(userID string) string {
	sum := sha256.Sum256([]byte("trioditis/login-browser/" + userID))
	return hex.EncodeToString(sum[:16])
}

// ErrBusy is Watch's error for a browser that has already finished.
var ErrBusy = errors.New("signin: the browser has finished")

// Watch shows the browser to a viewer until the viewer leaves or the browser ends. A new
// viewer replaces the last.
func (b *Browser) Watch(ctx context.Context, ws *websocket.Conn) error {
	ws.SetReadLimit(64 << 10)
	if err := b.start(); err != nil {
		code := "internal"
		if errors.Is(err, ErrOwnerBusy) {
			code = "busy"
		} else {
			b.log.Warn().Str("error_type", errorType(err)).Msg("Sign-in browser didn't start")
		}
		writeJSON(ctx, ws, map[string]any{"type": "error", "error": code})
		_ = ws.Close(websocket.StatusInternalError, "")
		return err
	}
	v := newViewer(b, ws)
	b.lock.Lock()
	if b.finished || b.ctx.Err() != nil {
		b.lock.Unlock()
		_ = ws.Close(websocket.StatusNormalClosure, "")
		return ErrBusy
	}
	old := b.viewer
	b.viewer = v
	if b.idle != nil {
		b.idle.Stop()
	}
	view := b.view
	b.lock.Unlock()
	if old != nil {
		old.close()
	}
	v.send(map[string]any{"type": "viewport", "width": view.Width, "height": view.Height, "scale": view.Scale})
	// The screencast restarts for the new viewer, which sends the page as it is now.
	b.unshow()
	b.show()
	v.run(ctx)

	b.lock.Lock()
	if b.viewer == v {
		b.viewer = nil
		if !b.params.Hidden {
			b.idle = time.AfterFunc(idleLimit, b.Close)
		}
	}
	b.lock.Unlock()
	b.show()
	return nil
}

// unshow marks every page's screencast as stopped, so show starts it again.
func (b *Browser) unshow() {
	b.lock.Lock()
	var running []*page
	for _, p := range b.pages {
		if p.shown {
			running = append(running, p)
			p.shown = false
		}
	}
	conn := b.conn
	b.lock.Unlock()
	if conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
	defer cancel()
	for _, p := range running {
		_ = conn.call(ctx, p.session, "Page.stopScreencast", nil, nil)
	}
}

func errorType(err error) string {
	var cdpErr *cdpError
	switch {
	case errors.As(err, &cdpErr):
		return "devtools"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		// The browser was closed while it started: its login was cancelled or moved on.
		return "closed"
	default:
		return "connection"
	}
}

// decodeFrame turns a screencast frame's base64 into JPEG bytes.
func decodeFrame(data string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(data)
}

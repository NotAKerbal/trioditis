// Command login-browser runs the sign-in browser's Chromiums: one for each connection to
// GET /v1/browser, driven over the connection through Chromium's DevTools pipe, and killed,
// its profile removed, when the connection closes. It holds no secret but its own token,
// LOGIN_BROWSER_TOKEN, which only lets a bridge host start browsers. See
// docs/architecture/signin-browser.md, The launcher.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// lifetime is the longest one browser runs, whatever its bridge host asks.
const lifetime = 20 * time.Minute

type launcher struct {
	token    string
	chromium string
	tmp      string
	ua       string
	sandbox  bool
	// slots bounds the browsers running at once, and perPerson those of any one person
	// (owners, by the bridge host's name for them), so one can't take them all.
	slots     chan struct{}
	perPerson int
	ownerLock sync.Mutex
	owners    map[string][]*ownerSession
	// users, if set, gives each browser a user of its own, never used again while the
	// launcher runs: one login's Chromium can't read another's profile or reach its processes,
	// and nothing one leaves behind can be read by a later one.
	users *userPool
	log   zerolog.Logger

	stopping context.Context
	// admission counts the browsers being served, and stops new ones once draining.
	admission admission
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "remove-profile" {
		removeProfile(os.Args[2])
		return
	}
	log := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}).With().Timestamp().Logger()
	l := &launcher{token: os.Getenv("LOGIN_BROWSER_TOKEN"), log: log}
	if l.token == "" {
		log.Fatal().Msg("LOGIN_BROWSER_TOKEN is required")
	}
	var err error
	if l.chromium, err = findChromium(os.Getenv("CHROMIUM_PATH")); err != nil {
		log.Fatal().Err(err).Msg("No Chromium")
	}
	if l.ua, err = defaultUserAgent(l.chromium); err != nil {
		log.Fatal().Err(err).Str("chromium", l.chromium).Msg("Chromium doesn't run")
	}
	// The profile, cache included, holds the person's session while they sign in, so it is
	// kept in memory.
	l.tmp = env("LOGIN_BROWSER_TMP", "/dev/shm")
	if info, err := os.Stat(l.tmp); err != nil || !info.IsDir() {
		log.Fatal().Str("dir", l.tmp).Msg("LOGIN_BROWSER_TMP isn't a directory")
	}
	// Chromium's own sandbox needs user namespaces, which a container usually doesn't
	// allow; there the container is the sandbox (deploy/compose/compose.yml).
	l.sandbox = os.Getenv("LOGIN_BROWSER_NO_SANDBOX") != "1"
	max, err := strconv.Atoi(env("LOGIN_BROWSER_MAX", "4"))
	if err != nil || max < 1 {
		log.Fatal().Msg("LOGIN_BROWSER_MAX must be a positive number")
	}
	if value := os.Getenv("LOGIN_BROWSER_UIDS"); value != "" {
		first, last, err := userRange(value)
		if err != nil {
			log.Fatal().Msg("LOGIN_BROWSER_UIDS must be a range of user IDs, first-last")
		}
		l.users = &userPool{next: first, last: last}
	}
	l.slots = make(chan struct{}, max)
	if l.perPerson, err = strconv.Atoi(env("LOGIN_BROWSER_PER_PERSON", "1")); err != nil || l.perPerson < 1 {
		log.Fatal().Msg("LOGIN_BROWSER_PER_PERSON must be a positive number")
	}
	l.owners = map[string][]*ownerSession{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /v1/browser", l.serve)
	addr := env("LOGIN_BROWSER_ADDR", "127.0.0.1:9222")
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Every browser's handler runs under ctx: the server's Close doesn't reach a connection
	// that has become a websocket, so stopping ends each browser this way, and waits for its
	// Chromium to be killed and its profile removed.
	l.stopping = ctx
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	log.Info().Str("addr", addr).Str("chromium", l.chromium).Msg("Login browser running")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal().Err(err).Msg("Login browser stopped")
	}
	<-l.admission.drain()
}

func findChromium(want string) (string, error) {
	if want != "" {
		return exec.LookPath(want)
	}
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome-stable", "google-chrome"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", errors.New("set CHROMIUM_PATH, or put chromium or google-chrome on PATH")
}

var versionNumber = regexp.MustCompile(`\b(\d+)\.\d+\.\d+\.\d+\b`)

// defaultUserAgent is the user agent of an ordinary Chromium of this version on Linux, for
// a step that doesn't name one: a headless Chromium's own says "HeadlessChrome".
func defaultUserAgent(chromium string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, chromium, "--version").Output()
	if err != nil {
		return "", err
	}
	m := versionNumber.FindStringSubmatch(string(out))
	if m == nil {
		return "", fmt.Errorf("can't read the version from %q", strings.TrimSpace(string(out)))
	}
	return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + m[1] + ".0.0.0 Safari/537.36", nil
}

func (l *launcher) authorized(r *http.Request) bool {
	return subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+l.token)) == 1
}

var ownerName = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ownerSession is one of a person's browsers: how to end it, and when it has ended.
type ownerSession struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// takeOwner counts a browser for owner. A person past their limit is most likely starting
// again (a reload, a new login) with an older browser still waiting out its idle time, so
// their oldest is ended to make room, rather than this one turned away; it reports false only
// if that one doesn't end in time. Nobody can end someone else's: the bridge host names the
// owner.
func (l *launcher) takeOwner(ctx context.Context, owner string, s *ownerSession) bool {
	for {
		// A request that has gone (the bridge host gave up) ends nobody's browser.
		if ctx.Err() != nil {
			return false
		}
		l.ownerLock.Lock()
		// Asked again under the lock, which a cancelled request may have waited for.
		if ctx.Err() != nil {
			l.ownerLock.Unlock()
			return false
		}
		sessions := l.owners[owner]
		if len(sessions) < l.perPerson {
			l.owners[owner] = append(sessions, s)
			l.ownerLock.Unlock()
			return true
		}
		oldest := sessions[0]
		l.ownerLock.Unlock()
		oldest.cancel()
		select {
		case <-oldest.done:
		case <-ctx.Done():
			return false
		case <-time.After(cleanupLimit + 5*time.Second):
			return false
		}
	}
}

func (l *launcher) releaseOwner(owner string, s *ownerSession) {
	l.ownerLock.Lock()
	defer l.ownerLock.Unlock()
	sessions := slices.DeleteFunc(l.owners[owner], func(o *ownerSession) bool { return o == s })
	if len(sessions) == 0 {
		delete(l.owners, owner)
	} else {
		l.owners[owner] = sessions
	}
	close(s.done)
}

// admission counts the browsers being served. Once it drains it admits no more, and its
// channel closes when the last one is done.
type admission struct {
	lock     sync.Mutex
	active   int
	draining bool
	once     sync.Once
	idle     chan struct{}
}

func (a *admission) admit() bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.draining {
		return false
	}
	a.active++
	return true
}

func (a *admission) release() {
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.active--; a.draining && a.active == 0 {
		a.closeIdle()
	}
}

// drain stops admitting browsers and returns a channel that closes once none is being served.
func (a *admission) drain() <-chan struct{} {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.draining = true
	if a.active == 0 {
		a.closeIdle()
	}
	return a.idleChan()
}

func (a *admission) idleChan() chan struct{} {
	a.once.Do(func() { a.idle = make(chan struct{}) })
	return a.idle
}

// closeIdle closes the idle channel once. Called with a.lock.
func (a *admission) closeIdle() {
	select {
	case <-a.idleChan():
	default:
		close(a.idleChan())
	}
}

// userRange parses "first-last".
func userRange(value string) (int, int, error) {
	first, last, ok := strings.Cut(value, "-")
	a, errA := strconv.Atoi(first)
	b, errB := strconv.Atoi(last)
	if !ok || errA != nil || errB != nil || a < 1000 || b < a || b > 1<<30 {
		return 0, 0, errors.New("not a user ID range")
	}
	return a, b, nil
}

// userPool hands out each user ID in its range once.
type userPool struct {
	lock       sync.Mutex
	next, last int
}

func (p *userPool) take() (int, bool) {
	p.lock.Lock()
	defer p.lock.Unlock()
	if p.next > p.last {
		return 0, false
	}
	uid := p.next
	p.next++
	return uid, true
}

// cleanupLimit is how long a browser's user gets to end its processes and remove its profile.
const cleanupLimit = 15 * time.Second

// removeAs ends everything of a browser's user's and removes its profile, as that user
// (remove-profile, below). The user is never used again whatever happens, so a cleanup that
// fails or hangs (something of that user's stopped it) leaves nothing another login can
// read; the launcher then kills the helper and what it can find of that user's itself.
func (l *launcher) removeAs(uid int, dir string) {
	self, err := os.Executable()
	if err == nil {
		cmd := exec.Command(self, "remove-profile", dir)
		cmd.Env = []string{"LOGIN_BROWSER_TMP=" + l.tmp, "LOGIN_BROWSER_UIDS=" + os.Getenv("LOGIN_BROWSER_UIDS")}
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid), Groups: []uint32{}}}
		if err = cmd.Start(); err == nil {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case err = <-done:
			case <-time.After(cleanupLimit):
				_ = cmd.Process.Kill()
				<-done
				err = errors.New("cleanup timed out")
			}
		}
	}
	if err != nil {
		killUser(uid)
		l.log.Error().Err(err).Int("uid", uid).Msg("Couldn't clean up a browser; its user won't be used again")
	}
}

// killUser kills what it finds of uid's, from the launcher: the fallback when that user's own
// cleanup didn't finish.
func killUser(uid int) {
	for _, pid := range processesOf(uid, -1) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

// removeProfile runs as a slot's user once its browser has ended. It kills every other process
// of that user's: kill(-1) reaches them all in one call, so none can fork away from it. It is
// repeated until /proc shows none of them alive (kill(-1) itself can't say: it counts the
// processes it may not signal too). Then it removes the profile and whatever else of that user's Chromium left in the
// profiles' directory (shared memory files, when it is /dev/shm). It exits non-zero unless
// all of that is done.
func removeProfile(dir string) {
	// kill(-1) ends everything its caller may signal, so this only ever runs as a browser's user.
	first, last, err := userRange(os.Getenv("LOGIN_BROWSER_UIDS"))
	if uid := os.Getuid(); err != nil || uid < first || uid > last {
		fmt.Fprintln(os.Stderr, "remove-profile only runs as one of LOGIN_BROWSER_UIDS")
		os.Exit(3)
	}
	gone := false
	for range 250 {
		_ = syscall.Kill(-1, syscall.SIGKILL)
		if len(processesOf(os.Getuid(), os.Getpid())) == 0 {
			gone = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !gone {
		os.Exit(2)
	}
	if err := os.RemoveAll(dir); err != nil {
		os.Exit(1)
	}
	for _, tmp := range []string{env("LOGIN_BROWSER_TMP", "/dev/shm"), os.TempDir()} {
		entries, _ := os.ReadDir(tmp)
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) == os.Getuid() {
				_ = os.RemoveAll(tmp + "/" + entry.Name())
			}
		}
	}
}

// processesOf lists the live processes of uid's but except: a dead one, waiting to be reaped,
// can do nothing. A process whose status can't be read is counted, as one that may be alive.
func processesOf(uid, except int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return []int{-1}
	}
	var pids []int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == except {
			continue
		}
		status, err := os.ReadFile("/proc/" + entry.Name() + "/status")
		if err != nil {
			// Gone between listing and reading.
			if !errors.Is(err, os.ErrNotExist) && except >= 0 {
				pids = append(pids, pid)
			}
			continue
		}
		mine, dead := false, false
		for line := range strings.Lines(string(status)) {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			switch fields[0] {
			case "Uid:":
				mine = fields[1] == strconv.Itoa(uid)
			case "State:":
				dead = fields[1] == "Z" || fields[1] == "X"
			}
		}
		if mine && !dead {
			pids = append(pids, pid)
		}
	}
	return pids
}

// maxMessage is the largest DevTools message passed on, as the bridge host takes it
// (internal/signin, maxMessage). A browser that sends a bigger one is ended, before it can use
// up memory the other browsers share.
const maxMessage = 32 << 20

var errTooLarge = errors.New("a DevTools message was too large")

// readMessage reads one NUL-terminated message, without the NUL, of at most maxMessage bytes.
func readMessage(br *bufio.Reader) ([]byte, error) {
	var data []byte
	for {
		chunk, err := br.ReadSlice(0)
		if len(data)+len(chunk) > maxMessage+1 {
			return nil, errTooLarge
		}
		data = append(data, chunk...)
		switch {
		case err == nil:
			return data[:len(data)-1], nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return nil, err
		}
	}
}

// chromiumEnv is the launcher's environment without its token: a page that took over Chromium
// would find nothing in it worth having.
func chromiumEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "LOGIN_BROWSER_TOKEN=") && !strings.HasPrefix(kv, "TRIODITIS_INTERNAL_TOKEN=") {
			out = append(out, kv)
		}
	}
	return out
}

// proxyURL checks the proxy a bridge host names: Chromium is only ever pointed at one.
func proxyURL(value string) (string, bool) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return "", false
	}
	return "http://" + u.Host, true
}

func (l *launcher) serve(w http.ResponseWriter, r *http.Request) {
	if !l.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	proxy, ok := proxyURL(r.URL.Query().Get("proxy"))
	if !ok {
		http.Error(w, "proxy must be an http://host:port URL", http.StatusBadRequest)
		return
	}
	ua := r.URL.Query().Get("ua")
	if ua == "" {
		ua = l.ua
	} else if len(ua) > 512 || strings.ContainsAny(ua, "\r\n\x00") {
		http.Error(w, "bad user agent", http.StatusBadRequest)
		return
	}
	// Admitted before anything else, so a launcher that stops (below, or on a signal) waits
	// for this browser's cleanup, and admits none after it has started to.
	if !l.admission.admit() {
		http.Error(w, "stopping", http.StatusServiceUnavailable)
		return
	}
	defer l.admission.release()
	owner := r.URL.Query().Get("owner")
	if !ownerName.MatchString(owner) {
		http.Error(w, "owner must be the bridge host's name for the person", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), lifetime)
	defer cancel()
	session := &ownerSession{cancel: cancel, done: make(chan struct{})}
	if !l.takeOwner(r.Context(), owner, session) {
		http.Error(w, "that person has a browser open", http.StatusTooManyRequests)
		return
	}
	// Last to run: the person's count drops only once this browser is entirely gone.
	defer l.releaseOwner(owner, session)
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	default:
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	uid := -1
	if l.users != nil {
		var ok bool
		if uid, ok = l.users.take(); !ok {
			// Every user has been used once. The launcher stops once the browsers it has
			// finish, and its container starts again with nothing left of any of them.
			http.Error(w, "busy", http.StatusServiceUnavailable)
			l.log.Warn().Msg("Every browser user has been used; stopping, to start afresh")
			idle := l.admission.drain()
			go func() {
				<-idle
				os.Exit(1)
			}()
			return
		}
	}
	if l.stopping.Err() != nil {
		http.Error(w, "stopping", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(4 << 20)
	stop := context.AfterFunc(l.stopping, cancel)
	defer stop()
	if err = l.run(ctx, ws, proxy, ua, uid); err != nil {
		l.log.Warn().Err(err).Msg("Browser ended")
	}
}

// run starts one Chromium, as uid when it isn't -1, and relays DevTools messages between it
// and ws until either ends.
func (l *launcher) run(ctx context.Context, ws *websocket.Conn, proxy, ua string, uid int) error {
	dir, err := os.MkdirTemp(l.tmp, "login-browser-")
	if err != nil {
		return err
	}
	if uid >= 0 {
		if err = os.Chown(dir, uid, uid); err != nil {
			os.RemoveAll(dir)
			return err
		}
		// Removed by the browser's own user, the only one that can read inside it, once
		// nothing of that user's is left running. Deferred first, so it runs last.
		defer l.removeAs(uid, dir)
	} else {
		defer os.RemoveAll(dir)
	}
	toChrome, commands, err := os.Pipe()
	if err != nil {
		return err
	}
	replies, fromChrome, err := os.Pipe()
	if err != nil {
		toChrome.Close()
		commands.Close()
		return err
	}
	args := []string{
		"--headless=new",
		"--remote-debugging-pipe",
		"--user-data-dir=" + dir,
		"--proxy-server=" + proxy,
		// Without this, Chromium goes to localhost directly, around the proxy.
		"--proxy-bypass-list=<-loopback>",
		"--disable-quic",
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
		"--user-agent=" + ua,
		"--lang=en-US",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--disable-breakpad",
		"--disable-crash-reporter",
		"--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
		// Sites turn away a browser that says it's automated.
		"--disable-blink-features=AutomationControlled",
		"--deny-permission-prompts",
		"--password-store=basic",
		"--use-mock-keychain",
		"--mute-audio",
		"--window-size=1024,720",
	}
	if !l.sandbox {
		args = append(args, "--no-sandbox")
	}
	cmd := exec.Command(l.chromium, append(args, "about:blank")...)
	// Chromium reads commands from fd 3 and writes replies to fd 4.
	cmd.ExtraFiles = []*os.File{toChrome, fromChrome}
	cmd.Dir = dir
	cmd.Env = append(chromiumEnv(), "HOME="+dir, "TMPDIR="+dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if uid >= 0 {
		cmd.SysProcAttr.Credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid), Groups: []uint32{}}
	}
	if err = cmd.Start(); err != nil {
		toChrome.Close()
		commands.Close()
		replies.Close()
		fromChrome.Close()
		return err
	}
	// The child holds its own ends now.
	toChrome.Close()
	fromChrome.Close()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		// Chromium's helpers are in its process group, and go with it; with a user of its own,
		// anything of that user's that left the group goes too.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
		}
		commands.Close()
		replies.Close()
	}()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		defer cancel()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if _, err = commands.Write(append(data, 0)); err != nil {
				return
			}
		}
	}()
	go func() {
		defer cancel()
		br := bufio.NewReaderSize(replies, 1<<20)
		for {
			data, err := readMessage(br)
			if err != nil {
				// Over the limit, or Chromium gone: either way this browser ends.
				return
			}
			if err = ws.Write(ctx, websocket.MessageText, data); err != nil {
				return
			}
		}
	}()
	select {
	case <-ctx.Done():
		return nil
	case err = <-exited:
		exited <- err
		if err != nil {
			return fmt.Errorf("chromium exited: %w", err)
		}
		return nil
	}
}

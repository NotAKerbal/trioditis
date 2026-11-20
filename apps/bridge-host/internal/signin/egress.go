package signin

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/net/proxy"
)

// Egress is the forward proxy the sign-in browser reaches the web through, and its only way
// out (docs/architecture/signin-browser.md, Egress). It resolves names itself and connects
// only to public addresses on ports 80 and 443, so a page can't use the browser to reach the
// server's own services or its network.
type Egress struct {
	// Upstream, if set, is the proxy the network's connector goes out through (http, https,
	// socks5 or socks5h), so the sign-in comes from the same address the bridge connects from.
	Upstream *url.URL
	// Deny holds more ranges the proxy refuses, for addresses this server's network routes
	// somewhere local (BRIDGE_EGRESS_DENY).
	Deny []netip.Prefix
	Log  zerolog.Logger

	// allowed decides which addresses may be reached; public addresses only, unless a test
	// replaces it.
	allowed     func(netip.Addr) bool
	allowedPort func(string) bool
	resolver    *net.Resolver

	once    sync.Once
	slots   chan struct{}
	lock    sync.Mutex
	conns   map[net.Conn]struct{}
	stopped bool
}

// maxEgressConns bounds the connections one browser has open through its proxy at once.
const maxEgressConns = 128

const dialTimeout = 15 * time.Second

var errNotPublic = errors.New("signin: that address isn't on the public internet")

// blocked holds the ranges, beyond what netip's own tests cover, that aren't the public
// internet or that embed an address that may not be (NAT64, 6to4).
var blocked = func() []netip.Prefix {
	var prefixes []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16",
		// Azure's WireServer: public-looking, but answered by the VM's own host.
		"168.63.129.16/32",
	} {
		prefixes = append(prefixes, netip.MustParsePrefix(p))
	}
	return prefixes
}()

// publicAddr reports whether addr is on the public internet.
func publicAddr(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() ||
		addr.IsUnspecified() || addr == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
		return false
	}
	for _, p := range blocked {
		if p.Contains(addr) {
			return false
		}
	}
	return true
}

func (e *Egress) init() {
	e.once.Do(func() {
		if e.allowed == nil {
			e.allowed = func(addr netip.Addr) bool {
				if !publicAddr(addr) {
					return false
				}
				for _, p := range e.Deny {
					if p.Contains(addr.Unmap()) {
						return false
					}
				}
				return true
			}
		}
		if e.allowedPort == nil {
			e.allowedPort = func(port string) bool { return port == "80" || port == "443" }
		}
		if e.resolver == nil {
			e.resolver = net.DefaultResolver
		}
		e.slots = make(chan struct{}, maxEgressConns)
	})
}

// dial connects to host:port if the port is a web one and the host resolves to a public
// address, through the upstream proxy when there is one. The connection goes to the address
// that was checked, never to the name, so a second lookup can't send it somewhere else.
func (e *Egress) dial(ctx context.Context, host, port string) (net.Conn, error) {
	e.init()
	if !e.allowedPort(port) {
		return nil, fmt.Errorf("signin: port %s isn't a web port", port)
	}
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	var addrs []netip.Addr
	if addr, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		addrs = []netip.Addr{addr}
	} else if addrs, err = e.resolver.LookupNetIP(ctx, "ip", host); err != nil {
		return nil, err
	}
	var lastErr error = errNotPublic
	for _, addr := range addrs {
		if !e.allowed(addr) {
			continue
		}
		target := net.JoinHostPort(addr.Unmap().String(), port)
		conn, err := e.dialUpstream(ctx, target)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (e *Egress) dialUpstream(ctx context.Context, target string) (net.Conn, error) {
	direct := &net.Dialer{}
	if e.Upstream == nil {
		return direct.DialContext(ctx, "tcp", target)
	}
	switch e.Upstream.Scheme {
	case "socks5", "socks5h":
		dialer, err := proxy.FromURL(e.Upstream, direct)
		if err != nil {
			return nil, err
		}
		return dialer.(proxy.ContextDialer).DialContext(ctx, "tcp", target)
	case "http", "https":
		return connectThrough(ctx, e.Upstream, target)
	default:
		return nil, fmt.Errorf("signin: can't go out through a %s proxy", e.Upstream.Scheme)
	}
}

// connectThrough opens a tunnel to target through an http(s) proxy.
func connectThrough(ctx context.Context, upstream *url.URL, target string) (net.Conn, error) {
	addr := upstream.Host
	if upstream.Port() == "" {
		addr = net.JoinHostPort(upstream.Hostname(), map[string]string{"http": "80", "https": "443"}[upstream.Scheme])
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if upstream.Scheme == "https" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: upstream.Hostname()})
		if err = tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		conn = tlsConn
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if user := upstream.User; user != nil {
		password, _ := user.Password()
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(user.Username()+":"+password)) + "\r\n"
	}
	if _, err = io.WriteString(conn, req+"\r\n"); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("signin: the upstream proxy answered %d", resp.StatusCode)
	} else if br.Buffered() > 0 {
		conn.Close()
		return nil, errors.New("signin: the upstream proxy sent data before the tunnel opened")
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// hopHeaders are a single connection's, and aren't passed on (RFC 9110, section 7.6.1).
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
	"Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func (e *Egress) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.init()
	select {
	case e.slots <- struct{}{}:
		defer func() { <-e.slots }()
	default:
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodConnect {
		e.tunnel(w, r)
		return
	}
	// Plain HTTP, which a page reaches before it redirects to HTTPS.
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "not a proxy request", http.StatusBadRequest)
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return e.dial(ctx, host, port)
		},
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		// The browser follows redirects itself, through the proxy again.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(out)
	if err != nil {
		http.Error(w, "unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	for name, values := range resp.Header {
		w.Header()[name] = values
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (e *Egress) tunnel(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "bad address", http.StatusBadRequest)
		return
	}
	upstream, err := e.dial(r.Context(), host, port)
	if err != nil {
		// Which address was refused, or why, isn't logged: it says where the person was.
		http.Error(w, "unreachable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "can't tunnel", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	if _, err = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if !e.track(client, upstream) {
		return
	}
	defer e.untrack(client, upstream)
	// Each side's reads and writes must make progress: a site that stops reading, or stops
	// sending, can't hold the tunnel for good, whatever the browser does.
	client, upstream = idle{client}, idle{upstream}
	done := make(chan struct{}, 2)
	go func() {
		// What the browser sent after its CONNECT, already read into the buffer, goes first.
		if n := buffered.Reader.Buffered(); n > 0 {
			data, _ := buffered.Reader.Peek(n)
			_, _ = upstream.Write(data)
		}
		_, _ = io.Copy(upstream, client)
		closeWrite(upstream)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		closeWrite(client)
		done <- struct{}{}
	}()
	<-done
	// Once one side is done the other gets a moment to finish, not for ever: a site that
	// keeps its side open would otherwise hold the tunnel after the browser has gone.
	select {
	case <-done:
	case <-time.After(tunnelDrain):
		_ = client.Close()
		_ = upstream.Close()
		<-done
	}
}

// tunnelDrain is how long a tunnel stays open after one side has finished; tunnelIdle, how
// long a read or write in it may wait.
const (
	tunnelDrain = 10 * time.Second
	tunnelIdle  = 2 * time.Minute
)

// idle is a connection whose every read and write must finish within tunnelIdle.
type idle struct{ net.Conn }

func (c idle) Read(p []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(tunnelIdle))
	return c.Conn.Read(p)
}

func (c idle) Write(p []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(tunnelIdle))
	return c.Conn.Write(p)
}

func (c idle) CloseWrite() error {
	if tcp, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return tcp.CloseWrite()
	}
	return c.Conn.Close()
}

// track and untrack keep the tunnels open now, so stopping the proxy closes them. A tunnel
// opened as the proxy stops isn't tracked, and is closed at once.
func (e *Egress) track(conns ...net.Conn) bool {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.stopped {
		for _, c := range conns {
			_ = c.Close()
		}
		return false
	}
	if e.conns == nil {
		e.conns = map[net.Conn]struct{}{}
	}
	for _, c := range conns {
		e.conns[c] = struct{}{}
	}
	return true
}

func (e *Egress) untrack(conns ...net.Conn) {
	e.lock.Lock()
	defer e.lock.Unlock()
	for _, c := range conns {
		delete(e.conns, c)
	}
}

func (e *Egress) closeAll() {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.stopped = true
	for c := range e.conns {
		_ = c.Close()
	}
}

func closeWrite(conn net.Conn) {
	if tcp, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = tcp.CloseWrite()
	} else {
		_ = conn.Close()
	}
}

// ParseDeny reads a comma-separated list of address ranges (CIDR) or addresses.
func ParseDeny(value string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if p, err := netip.ParsePrefix(part); err == nil {
			// Addresses are compared as IPv4 when they are IPv4-mapped, so a mapped range is too.
			if p.Addr().Is4In6() {
				if p.Bits() < 96 {
					return nil, fmt.Errorf("signin: %q mixes IPv4 and IPv6", part)
				}
				p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
			}
			out = append(out, p.Masked())
		} else if a, err := netip.ParseAddr(part); err == nil {
			out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
		} else {
			return nil, fmt.Errorf("signin: %q isn't an address range", part)
		}
	}
	return out, nil
}

// EgressPlan is how a bridge host gives each sign-in browser an egress proxy of its own: on
// a fresh port, with its own share of connections, and closed with the browser, so one browser
// can neither use up another's nor keep anything open once it's gone.
type EgressPlan struct {
	Upstream *url.URL
	Deny     []netip.Prefix
	// Bind is the address each proxy listens on (BRIDGE_EGRESS_BIND); Host, the name Chromium
	// reaches this host at (BRIDGE_EGRESS_HOST), Bind itself when empty.
	Bind string
	Host string
	Log  zerolog.Logger

	// For tests, as on Egress.
	allowed     func(netip.Addr) bool
	allowedPort func(string) bool
}

// Open starts a browser's proxy and returns its URL and how to stop it.
func (p *EgressPlan) Open() (string, func(), error) {
	e := &Egress{Upstream: p.Upstream, Deny: p.Deny, Log: p.Log, allowed: p.allowed, allowedPort: p.allowedPort}
	return ListenEgress(e, net.JoinHostPort(p.Bind, "0"), p.Host)
}

// ListenEgress starts the egress proxy on addr and returns the URL Chromium is to use for it,
// at host (the listener's own address when empty), and how to stop it.
func ListenEgress(e *Egress, addr, host string) (string, func(), error) {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return "", nil, fmt.Errorf("signin: can't listen for the egress proxy: %w", err)
	}
	tcp, _ := listener.Addr().(*net.TCPAddr)
	if tcp == nil {
		listener.Close()
		return "", nil, errors.New("signin: the egress proxy isn't on TCP")
	}
	if host == "" {
		if tcp.IP.IsUnspecified() {
			listener.Close()
			return "", nil, errors.New("signin: the egress proxy listens on every address; set the name the browser reaches it at")
		}
		host = tcp.IP.String()
	}
	server := &http.Server{Handler: e, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return "http://" + net.JoinHostPort(host, strconv.Itoa(tcp.Port)), func() { _ = server.Close(); e.closeAll() }, nil
}

// FromBrowser reports whether a connection comes from the sign-in browser's own address,
// found from the launcher's URL: the browser shares a network with the bridge hosts to reach
// their egress proxies, and must reach nothing else of theirs. The name is looked up again
// every few seconds, since the container's address can change when it restarts. A launcher
// on loopback (pnpm dev) shares the machine anyway, and nothing is refused.
func FromBrowser(launcherURL string) func(netip.Addr) bool {
	u, err := url.Parse(launcherURL)
	if err != nil || u.Hostname() == "" || u.Hostname() == "localhost" {
		return func(netip.Addr) bool { return false }
	}
	host := u.Hostname()
	if addr, err := netip.ParseAddr(host); err == nil {
		if addr.IsLoopback() {
			return func(netip.Addr) bool { return false }
		}
		return func(remote netip.Addr) bool { return remote.Unmap() == addr.Unmap() }
	}
	var lock sync.Mutex
	var addrs []netip.Addr
	var looked time.Time
	return func(remote netip.Addr) bool {
		lock.Lock()
		defer lock.Unlock()
		if time.Since(looked) > 5*time.Second {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			found, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			cancel()
			// A failed lookup keeps the last answer rather than letting everything through.
			if err == nil {
				addrs, looked = found, time.Now()
			}
		}
		for _, addr := range addrs {
			if addr.Unmap() == remote.Unmap() {
				return true
			}
		}
		return false
	}
}

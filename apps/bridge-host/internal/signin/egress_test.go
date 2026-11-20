package signin

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPublicAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"93.184.215.14":        true,
		"2606:4700::6810:84e5": true,
		"127.0.0.1":            false,
		"10.1.2.3":             false,
		"172.17.0.2":           false,
		"192.168.1.1":          false,
		"169.254.169.254":      false, // cloud metadata
		"100.100.100.200":      false, // CGNAT, and Alibaba's metadata
		"0.0.0.0":              false,
		"224.0.0.1":            false,
		"255.255.255.255":      false,
		"::1":                  false,
		"::ffff:127.0.0.1":     false,
		"::ffff:10.0.0.1":      false,
		"fd00::1":              false,
		"fe80::1":              false,
		"64:ff9b::a00:1":       false, // NAT64 of 10.0.0.1
		"2002:a00:1::1":        false, // 6to4 of 10.0.0.1
		"168.63.129.16":        false, // Azure's WireServer
	} {
		if got := publicAddr(netip.MustParseAddr(addr)); got != want {
			t.Errorf("publicAddr(%s) = %v, want %v", addr, got, want)
		}
	}
}

// proxyGet sends a request through the proxy and returns the status it answers.
func connectStatus(t *testing.T, proxyAddr, target string) int {
	conn, err := net.Dial("tcp", proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode
}

func TestEgressRefusesWhatIsntPublic(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "secret") }))
	defer site.Close()
	proxyURL, stop, err := ListenEgress(&Egress{}, "127.0.0.1:0", "")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	addr := strings.TrimPrefix(proxyURL, "http://")
	siteHost := strings.TrimPrefix(site.URL, "http://")

	// Loopback, by address and by name, and a port that isn't a web one.
	for _, target := range []string{siteHost, "localhost:443", "127.0.0.1:443", "[::1]:443", "169.254.169.254:80", "example.com:22"} {
		if status := connectStatus(t, addr, target); status != http.StatusBadGateway {
			t.Errorf("CONNECT %s: %d, want 502", target, status)
		}
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(mustURL(proxyURL))}}
	resp, err := client.Get(site.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || strings.Contains(string(body), "secret") {
		t.Errorf("plain GET of a loopback site: %d %q, want 502", resp.StatusCode, body)
	}
}

func mustURL(value string) *url.URL {
	u, err := url.Parse(value)
	if err != nil {
		panic(err)
	}
	return u
}

func TestEgressTunnelsAndProxies(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("a proxy header reached the site")
		}
		fmt.Fprint(w, "hello")
	}))
	defer site.Close()
	open := &Egress{allowed: func(netip.Addr) bool { return true }, allowedPort: func(string) bool { return true }}
	proxyURL, stop, err := ListenEgress(open, "127.0.0.1:0", "")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(mustURL(proxyURL))}, Timeout: 10 * time.Second}
	resp, err := client.Get(site.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hello" {
		t.Errorf("plain GET: %q", body)
	}

	// CONNECT, through an upstream http proxy that itself only tunnels.
	var tunnelled string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "tunnels only", http.StatusMethodNotAllowed)
			return
		}
		tunnelled = r.Host
		target, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, "no", http.StatusBadGateway)
			return
		}
		defer target.Close()
		conn, _, _ := w.(http.Hijacker).Hijack()
		defer conn.Close()
		io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n")
		go io.Copy(target, conn)
		io.Copy(conn, target)
	}))
	defer upstream.Close()
	open.Upstream = mustURL(upstream.URL)
	conn, err := open.dial(context.Background(), "localhost", strings.Split(strings.TrimPrefix(site.URL, "http://"), ":")[1])
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	reply, _ := io.ReadAll(conn)
	if !strings.HasSuffix(string(reply), "hello") {
		t.Errorf("through the upstream: %q", reply)
	}
	// The upstream is given the address that was checked, not the name.
	if strings.HasPrefix(tunnelled, "localhost") {
		t.Errorf("the upstream was asked for %q, a name", tunnelled)
	}
}

func TestEgressDeny(t *testing.T) {
	deny, err := ParseDeny("203.0.114.0/24, 198.51.99.7, ::ffff:203.0.115.0/120")
	if err != nil {
		t.Fatal(err)
	}
	e := &Egress{Deny: deny}
	e.init()
	for addr, want := range map[string]bool{"203.0.114.9": false, "198.51.99.7": false, "198.51.99.8": true, "93.184.215.14": true, "203.0.115.5": false, "203.0.116.5": true} {
		if got := e.allowed(netip.MustParseAddr(addr)); got != want {
			t.Errorf("allowed(%s) = %v, want %v", addr, got, want)
		}
	}
	if _, err := ParseDeny("::ffff:0.0.0.0/64"); err == nil {
		t.Error("a range mixing IPv4 and IPv6 was taken")
	}
	if _, err := ParseDeny("not-a-range"); err == nil {
		t.Error("a bad range was taken")
	}
}

// Each browser gets its own proxy, which closes with it.
func TestEachBrowserHasItsOwnProxy(t *testing.T) {
	plan := &EgressPlan{Bind: "127.0.0.1"}
	a, stopA, err := plan.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, stopB, err := plan.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer stopB()
	if a == b {
		t.Fatalf("two browsers share %s", a)
	}
	stopA()
	if conn, err := net.DialTimeout("tcp", strings.TrimPrefix(a, "http://"), time.Second); err == nil {
		conn.Close()
		t.Error("a closed browser's proxy still answers")
	}
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(b, "http://"), time.Second)
	if err != nil {
		t.Fatalf("closing one browser's proxy closed another's: %v", err)
	}
	conn.Close()
	if _, _, err := (&EgressPlan{Bind: "0.0.0.0"}).Open(); err == nil {
		t.Error("a proxy on every address, with no name to reach it at, was opened")
	}
	if url, stop, err := (&EgressPlan{Bind: "0.0.0.0", Host: "bridge-meta"}).Open(); err != nil || !strings.HasPrefix(url, "http://bridge-meta:") {
		t.Errorf("Open = %q, %v", url, err)
	} else {
		stop()
	}
}

package bluebubbles

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

// A login's server address is whatever a member typed, and the bridge host dials it from
// inside the server, so where it may go is the operator's call, not the member's. By default
// only the public internet: a Mac reached through BlueBubbles' own Cloudflare or ngrok
// proxy, or a public address. A private range (a home network, a tailnet) is allowed only
// when the operator lists it (IMESSAGE_MAC_NETWORKS), since the server's own machine and
// its neighbours are there too. Whatever is listed, these are never a Mac's: loopback,
// link-local (cloud metadata services answer there), the clouds' other metadata addresses,
// the operator's own denied ranges (BRIDGE_EGRESS_DENY), and, inside a container, the
// container's own networks, where the server's database, Convex and gateway answer.

// ErrAddressRefused is how a connection to an address a Mac can't be at fails.
var ErrAddressRefused = errors.New("bluebubbles: that address isn't one a Mac may be at on this server")

// never are ranges no listing opens: beyond what netip's own tests cover, they can't be a
// Mac's, or are answered by the machine itself.
var never = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("168.63.129.16/32"),   // Azure's WireServer
	netip.MustParsePrefix("100.100.100.200/32"), // Alibaba Cloud's metadata service
	netip.MustParsePrefix("fd00:ec2::254/128"),  // AWS's metadata service over IPv6
	netip.MustParsePrefix("240.0.0.0/4"),
}

// notPublic are ranges that aren't the public internet, beyond what netip's IsPrivate covers,
// or that embed an address that may not be (NAT64, 6to4); a listing can open them.
var notPublic = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT, and Tailscale
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
}

// Policy is where a Mac may be: the public internet, and the ranges in Allowed, except Deny
// and the bridge host's own networks (Own, for tests; the container's own if nil).
type Policy struct {
	Allowed []netip.Prefix
	Deny    []netip.Prefix
	Own     func() []netip.Prefix
}

func contains(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Allows reports whether a connection may go to addr.
func (p Policy) Allows(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsUnspecified() || addr.IsLinkLocalUnicast() ||
		addr.IsMulticast() || addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() ||
		addr == netip.AddrFrom4([4]byte{255, 255, 255, 255}) || contains(never, addr) || contains(p.Deny, addr) {
		return false
	}
	own := p.Own
	if own == nil {
		own = containerNetworks
	}
	if contains(own(), addr) {
		return false
	}
	if contains(p.Allowed, addr) {
		return true
	}
	return !addr.IsPrivate() && !contains(notPublic, addr)
}

// ParseNetworks reads a comma-separated list of address ranges (or single addresses), as
// IMESSAGE_MAC_NETWORKS and BRIDGE_EGRESS_DENY are written.
func ParseNetworks(value string) ([]netip.Prefix, error) {
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
					return nil, fmt.Errorf("bluebubbles: %q mixes IPv4 and IPv6", part)
				}
				p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
			}
			out = append(out, p.Masked())
		} else if a, err := netip.ParseAddr(part); err == nil {
			out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
		} else {
			return nil, fmt.Errorf("bluebubbles: %q isn't an address range", part)
		}
	}
	return out, nil
}

var (
	ownNetworksOnce sync.Once
	ownNetworks     []netip.Prefix
)

// containerNetworks are the networks this process's own interfaces are on, when it runs in a
// container (Docker writes /.dockerenv). Outside one, as in development, the Mac can share
// the machine's own network, so nothing is refused for that.
func containerNetworks() []netip.Prefix {
	ownNetworksOnce.Do(func() {
		if _, err := os.Stat("/.dockerenv"); err != nil {
			return
		}
		addrs, err := net.InterfaceAddrs()
		if err != nil {
			return
		}
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok {
				if p, err := netip.ParsePrefix(ipNet.String()); err == nil {
					ownNetworks = append(ownNetworks, p.Masked())
				}
			}
		}
	})
	return ownNetworks
}

// AddressPolicy says whether a connection may go to an address.
type AddressPolicy func(netip.Addr) bool

// guardedDialer dials only addresses the policy allows. The check runs on the address being
// connected to, after the name is looked up, so a name can't lead past it.
func guardedDialer(allow AddressPolicy) *net.Dialer {
	return &net.Dialer{
		Timeout: dialTimeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return fmt.Errorf("bluebubbles: dialling %q: %w", network, err)
			}
			if !allow(ap.Addr()) {
				return ErrAddressRefused
			}
			return nil
		},
	}
}

// dialTimeout bounds opening a connection: a Mac that's asleep or gone doesn't answer.
const dialTimeout = 15 * time.Second

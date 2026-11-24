package bluebubbles

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sync"
	"syscall"
	"time"
)

// A login's server address is whatever the person typed, and the bridge host dials it from
// inside the server. The Mac is usually on their home network, a tailnet or a tunnel, so
// private and carrier-grade NAT addresses are allowed; what is refused is anything that
// would reach the bridge host itself or the machine it runs on rather than a Mac: loopback,
// link-local (cloud metadata services live there), the clouds' other metadata addresses,
// and, inside a container, the container's own networks, where the server's other services
// (its database, Convex, the gateway) answer.

// ErrAddressRefused is how a connection to an address a Mac can't be at fails.
var ErrAddressRefused = errors.New("bluebubbles: that address can't be a Mac's")

var refusedAddrs = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("168.63.129.16/32"),   // Azure's WireServer
	netip.MustParsePrefix("100.100.100.200/32"), // Alibaba Cloud's metadata service
	netip.MustParsePrefix("fd00:ec2::254/128"),  // AWS's metadata service over IPv6
}

// addressAllowed reports whether a connection may go to addr.
func addressAllowed(addr netip.Addr, own []netip.Prefix) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsUnspecified() || addr.IsLinkLocalUnicast() ||
		addr.IsMulticast() || addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() ||
		addr == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
		return false
	}
	for _, p := range refusedAddrs {
		if p.Contains(addr) {
			return false
		}
	}
	for _, p := range own {
		if p.Contains(addr) {
			return false
		}
	}
	return true
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

// DefaultPolicy allows the addresses a Mac can be at (see above).
func DefaultPolicy(addr netip.Addr) bool { return addressAllowed(addr, containerNetworks()) }

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

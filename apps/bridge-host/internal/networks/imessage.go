package networks

import (
	"fmt"
	"os"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// iMessage reaches each person's own Mac through the BlueBubbles Server on it. The connector
// is the bridge host's own (internal/imessage): no mautrix connector speaks BlueBubbles on
// bridgev2. See docs/networks/imessage.md.
//
// Where a Mac may be is the operator's choice: the public internet, and the private ranges
// in IMESSAGE_MAC_NETWORKS (a home network, a tailnet), never BRIDGE_EGRESS_DENY's.
func init() {
	register("imessage", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			policy, err := imessagePolicy(os.Getenv("IMESSAGE_MAC_NETWORKS"), os.Getenv("BRIDGE_EGRESS_DENY"))
			if err != nil {
				return nil, err
			}
			return imessage.NewConnector(policy.Allows), nil
		},
	})
}

func imessagePolicy(allowed, deny string) (bluebubbles.Policy, error) {
	var policy bluebubbles.Policy
	var err error
	if policy.Allowed, err = bluebubbles.ParseNetworks(allowed); err != nil {
		return policy, fmt.Errorf("IMESSAGE_MAC_NETWORKS: %w", err)
	}
	if policy.Deny, err = bluebubbles.ParseNetworks(deny); err != nil {
		return policy, fmt.Errorf("BRIDGE_EGRESS_DENY: %w", err)
	}
	return policy, nil
}

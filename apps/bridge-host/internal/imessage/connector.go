// Package imessage is the iMessage network: a bridgev2 connector that reaches the person's
// Messages app through a BlueBubbles Server running on their Mac. The Mac sends and receives;
// this connector speaks to it over BlueBubbles' REST API and socket, from the bridge host.
// See docs/networks/imessage.md.
package imessage

import (
	"context"

	"go.mau.fi/util/configupgrade"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/simplevent"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// Connector is the iMessage network connector.
type Connector struct {
	bridge *bridgev2.Bridge
	// allow says which addresses a Mac can be at: the public internet alone if nil.
	allow bluebubbles.AddressPolicy
}

// The bridge host watches how bridgev2's handling of each new message really ends (package
// handled): which of its parts were journaled, and whether it all succeeded, also after
// bridgev2 has stopped waiting on a slow handler. A message is known by the BlueBubbles message
// it was made from.
func init() {
	handled.AddKey(func(remote any) any {
		if evt, ok := remote.(*simplevent.Message[*bluebubbles.Message]); ok && evt.Type == bridgev2.RemoteEventMessage {
			return evt.Data
		}
		return nil
	})
}

// NewConnector makes the connector, reaching Macs only where allow allows.
func NewConnector(allow bluebubbles.AddressPolicy) *Connector { return &Connector{allow: allow} }

var _ bridgev2.NetworkConnector = (*Connector)(nil)

func (c *Connector) Init(br *bridgev2.Bridge)         { c.bridge = br }
func (c *Connector) Start(ctx context.Context) error  { return nil }
func (c *Connector) GetBridgeInfoVersion() (int, int) { return 1, 1 }

func (c *Connector) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{
		DisplayName:      "iMessage",
		NetworkURL:       "https://support.apple.com/messages",
		NetworkID:        "imessage",
		BeeperBridgeType: "imessage",
		DefaultPort:      29358,
	}
}

// GetConfig: the connector has no settings of its own. Where each person's Mac is, and its
// password, come with their login.
func (c *Connector) GetConfig() (string, any, configupgrade.Upgrader) { return "", nil, nil }

func (c *Connector) GetDBMetaTypes() database.MetaTypes {
	return database.MetaTypes{
		UserLogin: func() any { return &LoginMetadata{} },
		Message:   func() any { return &MessageMetadata{} },
	}
}

func (c *Connector) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}

// LoginMetadata is what a login keeps: where its BlueBubbles Server is and its password, and
// what the server said about itself when last asked.
type LoginMetadata struct {
	ServerURL string `json:"server_url"`
	Password  string `json:"password"`
	// SyncedUpTo is the time (Unix ms) up to which the login has been connected and handed
	// what arrived, so a reconnect catches up the chats that changed since.
	SyncedUpTo int64 `json:"synced_up_to,omitempty"`
}

func (c *Connector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	login.Client = newClient(c, login)
	return nil
}

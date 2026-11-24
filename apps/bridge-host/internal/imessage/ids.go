package imessage

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
)

// IDs are what the Mac's Messages app calls things, as BlueBubbles reports them, so they stay
// the same for the same thing: the bridge host keys its own opaque IDs on them.
//
//   - A login is its Mac: a hash of the server's computer ID.
//   - A chat is its GUID with the service written "any": "any;-;+15551234567" for a direct
//     chat, "any;+;chat123…" for a group. macOS 26 moved every chat to "any", and BlueBubbles
//     finds a chat by "any" on older systems too, so one chat keeps one ID across an upgrade.
//     It also makes someone's iMessage and SMS conversations one chat, as on an iPhone.
//   - A person is their address (a number in international form, or an email address)
//     within the login: "<login>|<address>". Their name and picture come from that Mac's
//     Contacts, which are the person's own: another member's chat with the same address must
//     not show them, so no one is shared between logins.
//   - A message is its GUID.

// loginID names the login for the Mac with this computer ID.
func loginID(computerID string) networkid.UserLoginID {
	sum := sha256.Sum256([]byte(computerID))
	return networkid.UserLoginID("mac-" + hex.EncodeToString(sum[:8]))
}

// chatID is a chat's ID: its GUID with the service written "any".
func chatID(guid string) networkid.PortalID {
	service, rest, ok := strings.Cut(guid, ";")
	if !ok || service == "" || !(strings.HasPrefix(rest, "-;") || strings.HasPrefix(rest, "+;")) {
		return networkid.PortalID(guid)
	}
	return networkid.PortalID("any;" + rest)
}

func (c *Client) portalKey(chatGUID string) networkid.PortalKey {
	// Every chat belongs to the login that sees it (the bridge host splits portals).
	return networkid.PortalKey{ID: chatID(chatGUID), Receiver: c.login.ID}
}

// normalAddress is an address as Messages matches it: an email address in lower case.
func normalAddress(address string) string {
	address = strings.TrimSpace(address)
	if strings.Contains(address, "@") {
		address = strings.ToLower(address)
	}
	return address
}

// userID is the person with this address, as this login knows them.
func (c *Client) userID(address string) networkid.UserID {
	return networkid.UserID(string(c.login.ID) + "|" + normalAddress(address))
}

// address is the address in a person's ID, if they belong to this login.
func (c *Client) address(id networkid.UserID) (string, bool) {
	login, address, ok := strings.Cut(string(id), "|")
	if !ok || login != string(c.login.ID) || address == "" {
		return "", false
	}
	return address, true
}

// dmAddress is the address a direct chat is with: "any;-;+1555…" → "+1555…". Empty for a
// group chat.
func dmAddress(id networkid.PortalID) string {
	parts := strings.SplitN(string(id), ";", 3)
	if len(parts) != 3 || parts[1] != "-" {
		return ""
	}
	return parts[2]
}

// targetGUID is the message a tapback points at. chat.db writes the target with the part it
// is on ("p:0/GUID"), as a whole message ("bp:GUID"), or as a bare GUID.
func targetGUID(associated string) string {
	if strings.HasPrefix(associated, "p:") {
		if i := strings.IndexByte(associated, '/'); i >= 0 {
			return associated[i+1:]
		}
	}
	return strings.TrimPrefix(associated, "bp:")
}

// sender is who sent something: the person themselves, or someone by their address.
func (c *Client) sender(fromMe bool, address string) bridgev2.EventSender {
	if fromMe {
		return bridgev2.EventSender{IsFromMe: true, SenderLogin: c.login.ID, Sender: c.selfID()}
	}
	return bridgev2.EventSender{Sender: c.userID(address)}
}

// selfID stands for the person themselves: the login with no address, which no one else's
// ID can be. Not the Apple ID: that can change, and a chat with one's own address is a chat
// like any other.
func (c *Client) selfID() networkid.UserID {
	return networkid.UserID(string(c.login.ID) + "|")
}

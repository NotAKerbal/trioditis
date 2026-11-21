// Package ids maps bridgev2's identifiers to the ones Trioditis uses.
//
// Two kinds of mapping live here:
//
//   - Matrix-shaped IDs (user, ghost and room IDs, event IDs) that bridgev2 needs but no
//     homeserver ever sees. They live on a fake server name and are only meaningful inside
//     this process and its database.
//   - Opaque protocol IDs (portalId, ghostId, loginId) that leave the bridge host. Network
//     IDs often contain phone numbers (WhatsApp JIDs are phone numbers), so they are keyed
//     hashes rather than the raw IDs; the reverse mapping is kept in the bridge host's
//     database, which already holds the raw IDs.
package ids

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// ServerName is the fake homeserver name every Matrix-shaped ID uses.
const ServerName = "trioditis.internal"

const (
	userPrefix  = "u_"
	ghostPrefix = "g_"
	BotMXID     = id.UserID("@bot:" + ServerName)
)

// UserMXID is the Matrix ID bridgev2 uses for a Trioditis user.
func UserMXID(userID string) id.UserID {
	return id.UserID("@" + userPrefix + id.EncodeUserLocalpart(userID) + ":" + ServerName)
}

// ParseUserMXID reverses UserMXID.
func ParseUserMXID(mxid id.UserID) (string, bool) {
	localpart, server, err := mxid.Parse()
	if err != nil || server != ServerName || !strings.HasPrefix(localpart, userPrefix) {
		return "", false
	}
	userID, err := id.DecodeUserLocalpart(strings.TrimPrefix(localpart, userPrefix))
	if err != nil {
		return "", false
	}
	return userID, true
}

// GhostMXID is the Matrix ID for a remote user.
func GhostMXID(userID networkid.UserID) id.UserID {
	return id.UserID("@" + ghostPrefix + id.EncodeUserLocalpart(string(userID)) + ":" + ServerName)
}

// ParseGhostMXID reverses GhostMXID.
func ParseGhostMXID(mxid id.UserID) (networkid.UserID, bool) {
	localpart, server, err := mxid.Parse()
	if err != nil || server != ServerName || !strings.HasPrefix(localpart, ghostPrefix) {
		return "", false
	}
	decoded, err := id.DecodeUserLocalpart(strings.TrimPrefix(localpart, ghostPrefix))
	if err != nil {
		return "", false
	}
	return networkid.UserID(decoded), true
}

func b64(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

// RoomID is the deterministic room ID for a portal. It encodes the portal key reversibly,
// so a room ID alone identifies its portal and, through the receiver, its owner.
func RoomID(key networkid.PortalKey) id.RoomID {
	return id.RoomID("!" + b64([]byte(string(key.ID)+"\x00"+string(key.Receiver))) + ":" + ServerName)
}

// ParseRoomID reverses RoomID.
func ParseRoomID(roomID id.RoomID) (networkid.PortalKey, bool) {
	s := string(roomID)
	if !strings.HasPrefix(s, "!") || !strings.HasSuffix(s, ":"+ServerName) {
		return networkid.PortalKey{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSuffix(strings.TrimPrefix(s, "!"), ":"+ServerName))
	if err != nil {
		return networkid.PortalKey{}, false
	}
	portalID, receiver, ok := strings.Cut(string(raw), "\x00")
	if !ok {
		return networkid.PortalKey{}, false
	}
	return networkid.PortalKey{ID: networkid.PortalID(portalID), Receiver: networkid.UserLoginID(receiver)}, true
}

func hashEventID(parts ...string) id.EventID {
	h := sha256.New()
	for _, part := range parts {
		// Length-prefix each part so no two different tuples hash the same.
		_, _ = fmt.Fprintf(h, "%d:%s|", len(part), part)
	}
	return id.EventID("$" + b64(h.Sum(nil)[:18]))
}

// MessageEventID is the deterministic event ID for a remote message part. It is the
// dedup key Convex uses, so it must never change for the same message.
func MessageEventID(key networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	return hashEventID("message", string(key.ID), string(key.Receiver), string(messageID), string(partID))
}

// ReactionEventID is the deterministic event ID for a reaction.
func ReactionEventID(key networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID, sender networkid.UserID, emojiID networkid.EmojiID) id.EventID {
	return hashEventID("reaction", string(key.ID), string(key.Receiver), string(messageID), string(partID), string(sender), string(emojiID))
}

// RemoteReactionEventID is the event ID for a reaction from the network, the dedup key Convex
// applies each reaction event once by. On networks where a person has one reaction per
// message (WhatsApp, Signal) the emoji ID is empty, so the target, sender and emoji ID alone
// would give a changed reaction, or one taken away and given again, the ID of the first, and
// it would be dropped as a replay. The network's own ID for the reaction (sourceID: a WhatsApp
// reaction is a message with its own ID) tells those apart, and a redelivery of the same
// reaction keeps it. Without one, the emoji and the network's timestamp do; WhatsApp's are
// whole seconds, which is why its ID comes first.
func RemoteReactionEventID(key networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID, sender networkid.UserID, emojiID networkid.EmojiID, emoji, sourceID string, ts time.Time) id.EventID {
	if sourceID != "" {
		return hashEventID("reaction/3", string(key.ID), string(key.Receiver), string(messageID), string(partID), string(sender), string(emojiID), emoji, sourceID)
	}
	var at string
	if !ts.IsZero() {
		at = strconv.FormatInt(ts.UnixMilli(), 10)
	}
	return hashEventID("reaction/2", string(key.ID), string(key.Receiver), string(messageID), string(partID), string(sender), string(emojiID), emoji, at)
}

// OutgoingEventID is the event ID of a message the person sent from Trioditis. It is
// derived from the client's ID, so a repeated command maps to the same event.
func OutgoingEventID(userID, clientMessageID string) id.EventID {
	return hashEventID("outgoing", userID, clientMessageID)
}

// CommandEventID is the event ID of another Matrix-side event a command creates, such as a
// reaction or redaction from Trioditis.
func CommandEventID(userID, commandID string) id.EventID {
	return hashEventID("command", userID, commandID)
}

// LocalEventID is an event ID for something with no stable identity, such as a state
// change. Callers pass enough context to make it unique.
func LocalEventID(parts ...string) id.EventID {
	return hashEventID(append([]string{"local"}, parts...)...)
}

// Kinds of opaque protocol ID.
const (
	KindPortal = "p"
	KindGhost  = "g"
	KindLogin  = "l"
)

// Opaquer turns network IDs into stable opaque protocol IDs with a keyed hash.
type Opaquer struct {
	key []byte
}

// LegacyOpaqueKey is the hashing key the first bridge hosts derived from the bridge private
// key. It is only used to keep the IDs an existing database already has, the first time a
// host with a dedicated ID key starts on it.
func LegacyOpaqueKey(bridgePrivateKey []byte) []byte {
	sum := sha256.Sum256(append([]byte("trioditis opaque ids v1\x00"), bridgePrivateKey...))
	return sum[:]
}

// NewOpaquer hashes with key: the bridge host's dedicated, durable ID key (see
// store.IDKey). It is separate from the bridge key so rotating that doesn't change every ID.
func NewOpaquer(key []byte) *Opaquer {
	return &Opaquer{key: append([]byte(nil), key...)}
}

// ID returns the opaque ID for a network ID of the given kind, e.g. `p_…`.
func (o *Opaquer) ID(network, kind, value string) string {
	mac := hmac.New(sha256.New, o.key)
	_, _ = fmt.Fprintf(mac, "%s\x00%s\x00%s", network, kind, value)
	return kind + "_" + b64(mac.Sum(nil)[:16])
}

// PortalValue is the string a portal's opaque ID is hashed from: its key when its room was
// created. It contains a NUL, so it is only hashed, never stored; the opaque ID's stored
// value is the room ID, which never changes even when the network re-IDs the portal.
func PortalValue(key networkid.PortalKey) string {
	return string(key.ID) + "\x00" + string(key.Receiver)
}

// ParsePortalValue reverses PortalValue, for migrating values stored before room IDs were.
func ParsePortalValue(value string) networkid.PortalKey {
	portalID, receiver, _ := strings.Cut(value, "\x00")
	return networkid.PortalKey{ID: networkid.PortalID(portalID), Receiver: networkid.UserLoginID(receiver)}
}

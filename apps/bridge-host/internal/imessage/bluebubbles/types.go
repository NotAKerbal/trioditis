package bluebubbles

import (
	"encoding/json"
	"strconv"
)

// What the server sends, as BlueBubbles Server serializes it. Times are Unix milliseconds.

// ServerInfo is the server's description of itself (GET /api/v1/server/info).
type ServerInfo struct {
	// ComputerID identifies the Mac.
	ComputerID    string `json:"computer_id"`
	ServerVersion string `json:"server_version"`
	OSVersion     string `json:"os_version"`
	// PrivateAPI is whether the Private API is switched on in the server's settings;
	// HelperConnected whether its helper is actually running inside Messages. Only both
	// together make the Private API's features work.
	PrivateAPI       bool   `json:"private_api"`
	HelperConnected  bool   `json:"helper_connected"`
	DetectedIMessage string `json:"detected_imessage"`
	DetectedICloud   string `json:"detected_icloud"`
}

// Handle is someone Messages has talked to: their address and the service it was on.
type Handle struct {
	Address string `json:"address"`
	Service string `json:"service"`
	Country string `json:"country"`
}

// Chat is one conversation.
type Chat struct {
	GUID           string   `json:"guid"`
	ChatIdentifier string   `json:"chatIdentifier"`
	DisplayName    string   `json:"displayName"`
	Style          int      `json:"style"`
	IsArchived     bool     `json:"isArchived"`
	Participants   []Handle `json:"participants"`
	LastMessage    *Message `json:"lastMessage"`
}

// Attachment is one file on a message.
type Attachment struct {
	GUID           string `json:"guid"`
	UTI            string `json:"uti"`
	MimeType       string `json:"mimeType"`
	TransferName   string `json:"transferName"`
	TotalBytes     int64  `json:"totalBytes"`
	TransferState  int    `json:"transferState"`
	IsSticker      bool   `json:"isSticker"`
	HideAttachment bool   `json:"hideAttachment"`
	Height         int    `json:"height"`
	Width          int    `json:"width"`
}

// Message is one message, tapback or chat event (a rename, someone added or leaving).
type Message struct {
	GUID     string  `json:"guid"`
	TempGUID string  `json:"tempGuid"`
	Text     string  `json:"text"`
	Subject  string  `json:"subject"`
	Handle   *Handle `json:"handle"`
	IsFromMe bool    `json:"isFromMe"`
	// Error is Messages' error code for a message that didn't go: 0 when it went.
	Error int `json:"error"`

	DateCreated   int64 `json:"dateCreated"`
	DateDelivered int64 `json:"dateDelivered"`
	DateRead      int64 `json:"dateRead"`
	DateEdited    int64 `json:"dateEdited"`
	DateRetracted int64 `json:"dateRetracted"`
	// PartCount is how many parts are left (macOS 13): 0 once every part was unsent.
	PartCount *int `json:"partCount"`
	// MessageSummaryInfo says which parts were unsent (retractedParts), when the server was
	// asked to read it.
	MessageSummaryInfo json.RawMessage `json:"messageSummaryInfo"`

	// A tapback points at the message it is on and says which it is ("love", "-love" when
	// taken back, "2006"/"3006" for any emoji, which the server doesn't name).
	AssociatedMessageGUID string          `json:"associatedMessageGuid"`
	AssociatedMessageType json.RawMessage `json:"associatedMessageType"`

	// A reply points at the first message of its thread.
	ThreadOriginatorGUID string `json:"threadOriginatorGuid"`

	// ItemType is 0 for a message; otherwise a change to the chat: 1 someone added or
	// removed (GroupActionType 0 or 1), 2 renamed (GroupTitle), 3 someone left or the
	// picture changed.
	ItemType        int    `json:"itemType"`
	GroupActionType int    `json:"groupActionType"`
	GroupTitle      string `json:"groupTitle"`

	// OtherHandle is the handle row a member change is about.
	OtherHandle int `json:"otherHandle"`

	IsAudioMessage  bool   `json:"isAudioMessage"`
	BalloonBundleID string `json:"balloonBundleId"`

	Chats       []Chat       `json:"chats"`
	Attachments []Attachment `json:"attachments"`
}

// TapbackType is the tapback's kind as the server names it: "love", "like", "dislike",
// "laugh", "emphasize", "question", "-" before one taken back, "emoji"/"-emoji" for any
// other emoji, or "" when the message isn't a tapback (a sticker on a message, say, is
// "sticker"). The server writes a name; Messages' own number stands in for one it can't.
func (m *Message) TapbackType() string {
	if len(m.AssociatedMessageType) == 0 || m.AssociatedMessageGUID == "" {
		return ""
	}
	var name string
	if json.Unmarshal(m.AssociatedMessageType, &name) != nil {
		var code int
		if json.Unmarshal(m.AssociatedMessageType, &code) != nil {
			return ""
		}
		name = strconv.Itoa(code)
	}
	if n, ok := tapbackNumbers[name]; ok {
		return n
	}
	return name
}

// Messages' numbers for tapbacks: 2000 to 2006 put one on (2006 any emoji), 3000 to 3006
// take it off.
var tapbackNumbers = map[string]string{
	"2000": "love", "2001": "like", "2002": "dislike", "2003": "laugh", "2004": "emphasize", "2005": "question", "2006": "emoji",
	"3000": "-love", "3001": "-like", "3002": "-dislike", "3003": "-laugh", "3004": "-emphasize", "3005": "-question", "3006": "-emoji",
}

// Unsent says the whole message was taken back. Newer macOS versions leave dateRetracted
// empty and mark an unsend as an edit that retracted every part (Message.ts isFullyUnsent).
func (m *Message) Unsent() bool {
	if m.DateRetracted != 0 {
		return true
	}
	if m.DateEdited == 0 || m.PartCount == nil || *m.PartCount != 0 {
		return false
	}
	var summary []struct {
		RetractedParts []int `json:"retractedParts"`
	}
	if json.Unmarshal(m.MessageSummaryInfo, &summary) != nil || len(summary) == 0 {
		// The server wasn't asked for the summary: no parts left after an edit is enough.
		return true
	}
	return len(summary[0].RetractedParts) > 0
}

// ChatGUID is the chat the message is in.
func (m *Message) ChatGUID() string {
	if len(m.Chats) == 0 {
		return ""
	}
	return m.Chats[0].GUID
}

// TypingIndicator is someone starting or stopping typing in a chat.
type TypingIndicator struct {
	Display bool   `json:"display"`
	GUID    string `json:"guid"`
}

// ChatReadStatus is a chat having been read (or marked unread) on the Mac or another device.
type ChatReadStatus struct {
	ChatGUID string `json:"chatGuid"`
	Read     bool   `json:"read"`
}

// Contact is an entry in the Mac's Contacts.
type Contact struct {
	DisplayName  string `json:"displayName"`
	FirstName    string `json:"firstName"`
	LastName     string `json:"lastName"`
	Nickname     string `json:"nickname"`
	Avatar       string `json:"avatar"`
	PhoneNumbers []struct {
		Address string `json:"address"`
	} `json:"phoneNumbers"`
	Emails []struct {
		Address string `json:"address"`
	} `json:"emails"`
}

// Name is how the contact is shown: their nickname or full name.
func (c *Contact) Name() string {
	switch {
	case c.DisplayName != "":
		return c.DisplayName
	case c.FirstName != "" || c.LastName != "":
		if c.FirstName == "" || c.LastName == "" {
			return c.FirstName + c.LastName
		}
		return c.FirstName + " " + c.LastName
	default:
		return c.Nickname
	}
}

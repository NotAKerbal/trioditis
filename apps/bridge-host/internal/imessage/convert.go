package imessage

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

var eventMessage = event.EventMessage

// maxFileBytes bounds a file brought in from the Mac, as the bridge host bounds one sent.
const maxFileBytes = 100 << 20

func textContent(text string) *event.MessageEventContent {
	return &event.MessageEventContent{MsgType: event.MsgText, Body: text}
}

func noticeContent(text string) *event.MessageEventContent {
	return &event.MessageEventContent{MsgType: event.MsgNotice, Body: text}
}

// convertAttachment fetches a file from the Mac and stores it as the message's n-th part.
// A file that can't be fetched becomes a note saying so, rather than losing the message.
func (c *Client) convertAttachment(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, att *bluebubbles.Attachment, n int) *bridgev2.ConvertedMessagePart {
	part := &bridgev2.ConvertedMessagePart{ID: networkid.PartID(fmt.Sprintf("a%d", n)), Type: eventMessage}
	content, err := c.fetchAttachment(ctx, portal, intent, att)
	if err != nil {
		zerolog.Ctx(ctx).Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Couldn't fetch a file from the Mac")
		content = noticeContent("A file couldn't be fetched from the Mac.")
	}
	part.Content = content
	return part
}

type errTooLarge struct{}

func (errTooLarge) Error() string { return "imessage: the file is too large" }

func (c *Client) fetchAttachment(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, att *bluebubbles.Attachment) (*event.MessageEventContent, error) {
	if c.bb == nil {
		return nil, bridgev2.ErrNotLoggedIn
	}
	if att.TotalBytes > maxFileBytes {
		return nil, errTooLarge{}
	}
	body, contentType, err := c.bb.Download(ctx, bluebubbles.AttachmentPath(att.GUID))
	if err != nil {
		return nil, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFileBytes {
		return nil, errTooLarge{}
	}
	mimeType := mediaType(contentType)
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = mediaType(att.MimeType)
	}
	if mimeType == "" {
		mimeType = mediaType(http.DetectContentType(data))
	}
	name := fileName(att.TransferName, mimeType)
	url, file, err := intent.UploadMedia(ctx, portal.MXID, data, name, mimeType)
	if err != nil {
		return nil, err
	}
	content := &event.MessageEventContent{
		MsgType:  msgTypeFor(mimeType),
		Body:     name,
		FileName: name,
		URL:      url,
		File:     file,
		Info: &event.FileInfo{
			MimeType: mimeType,
			Size:     len(data),
			Width:    att.Width,
			Height:   att.Height,
		},
	}
	return content, nil
}

// mediaType is a Content-Type's media type alone, in lower case.
func mediaType(contentType string) string {
	if contentType == "" {
		return ""
	}
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return strings.ToLower(mt)
}

func msgTypeFor(mimeType string) event.MessageType {
	switch {
	case strings.HasPrefix(mimeType, "image/"):
		return event.MsgImage
	case strings.HasPrefix(mimeType, "video/"):
		return event.MsgVideo
	case strings.HasPrefix(mimeType, "audio/"):
		return event.MsgAudio
	default:
		return event.MsgFile
	}
}

// fileName is the file's name with the extension of what it now is: the server hands
// pictures Messages keeps as HEIC over as JPEG, and voice messages as MP3.
func fileName(transferName, mimeType string) string {
	name := path.Base(strings.ReplaceAll(transferName, "\\", "/"))
	if name == "." || name == "/" || name == "" {
		name = "file"
	}
	ext := strings.ToLower(path.Ext(name))
	want := map[string]string{"image/jpeg": ".jpeg", "audio/mp3": ".mp3", "audio/mpeg": ".mp3"}[mimeType]
	if want != "" && ext != want && !(want == ".jpeg" && ext == ".jpg") {
		name = strings.TrimSuffix(name, path.Ext(name)) + want
	}
	return name
}

package imessage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

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
	data, contentType, err := c.download(ctx, bluebubbles.AttachmentPath(att.GUID))
	if err != nil {
		return nil, err
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

// downloadTries is how many times a file is asked for when the transfer breaks off: once the
// message is saved, a file it came without can't be fetched again.
var downloadTries = []time.Duration{0, 2 * time.Second, 5 * time.Second}

// download fetches a file whole, asking again if the transfer breaks off (it is only a read).
// A file the Mac says it hasn't got, or one too large, isn't asked for again.
func (c *Client) download(ctx context.Context, path string) ([]byte, string, error) {
	var err error
	for _, wait := range downloadTries {
		select {
		case <-ctx.Done():
			return nil, "", ctx.Err()
		case <-time.After(wait):
		}
		var body io.ReadCloser
		var contentType string
		body, contentType, err = c.bb.Download(ctx, path)
		if err == nil {
			var data []byte
			data, err = io.ReadAll(io.LimitReader(body, maxFileBytes+1))
			body.Close()
			if err == nil {
				if len(data) > maxFileBytes {
					return nil, "", errTooLarge{}
				}
				return data, contentType, nil
			}
		}
		var bbErr *bluebubbles.Error
		if errors.As(err, &bbErr) && bbErr.Status >= 400 && bbErr.Status < 500 {
			return nil, "", err
		}
	}
	return nil, "", err
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

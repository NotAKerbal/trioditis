package connector

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// A message's previews are kept small: they ride inside the sealed message, and no app shows
// more than a few lines of one. Small enough, too, that a short message with a preview still
// seals within the 4 KiB the inbox keeps of a chat's last message for its one-line snippet.
const (
	maxPreviews           = 3
	maxPreviewURLBytes    = 2048
	maxPreviewTitleBytes  = 300
	maxPreviewSiteBytes   = 100
	maxPreviewDescription = 400
)

// linkPreviews turns the previews a network sent with a message (WhatsApp, Signal, Telegram,
// Messenger and others make them on the sender's device) into the sealed message's own, with
// each picture stored as the owner's copy. A picture that can't be stored is left out rather
// than failing the message; the preview still has its words.
func (c *Connector) linkPreviews(ctx context.Context, o *owner, previews []*event.BeeperLinkPreview) []protocol.LinkPreview {
	var out []protocol.LinkPreview
	for _, p := range previews {
		if len(out) == maxPreviews {
			break
		}
		if p == nil {
			continue
		}
		link := previewURL(p)
		if link == "" {
			continue
		}
		preview := protocol.LinkPreview{
			URL:         link,
			Title:       truncateUTF8(strings.TrimSpace(p.Title), maxPreviewTitleBytes),
			Description: truncateUTF8(strings.TrimSpace(p.Description), maxPreviewDescription),
			SiteName:    truncateUTF8(strings.TrimSpace(p.SiteName), maxPreviewSiteBytes),
		}
		if p.ImageURL != "" {
			att, err := c.attachmentFor(ctx, p.ImageURL, o.userID)
			if err != nil {
				c.Log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("A link preview's picture couldn't be stored; keeping the preview without it")
			} else if mime := previewImageMime(p.ImageType, att.Mime); mime != "" {
				img := *att
				img.Mime, img.Width, img.Height = mime, int(p.ImageWidth), int(p.ImageHeight)
				// A preview's picture isn't a file anyone named.
				img.Name = ""
				preview.Image = &img
			}
		}
		// A preview with nothing to say beyond its link adds nothing the client can't draw itself.
		if preview.Title == "" && preview.Description == "" && preview.Image == nil {
			continue
		}
		out = append(out, preview)
	}
	return out
}

// previewURL is the address a preview is of: the link as it was written in the message, or
// else the page's own canonical address. The written one comes first because clients show a
// card only for a link the message has, so a preview can't bring in a destination of its own.
// Only a web address is kept, since clients open it.
func previewURL(p *event.BeeperLinkPreview) string {
	for _, candidate := range []string{p.MatchedURL, p.CanonicalURL} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || len(candidate) > maxPreviewURLBytes {
			continue
		}
		// A link written without its scheme ("example.com/a") is a web address too. One with
		// another scheme (mailto:, javascript:) isn't, and isn't made into one.
		lower := strings.ToLower(candidate)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			if strings.ContainsAny(candidate, ":@") {
				continue
			}
			candidate = "https://" + candidate
		}
		u, err := url.Parse(candidate)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			continue
		}
		return candidate
	}
	return ""
}

// previewImageMime is the picture's type, from the network or the upload; anything that
// isn't a picture is dropped, so a client never draws a file as one.
func previewImageMime(fromNetwork, fromUpload string) string {
	for _, mime := range []string{fromNetwork, fromUpload} {
		if strings.HasPrefix(mime, "image/") {
			return mime
		}
	}
	return ""
}

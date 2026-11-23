package connector

import (
	"context"
	"strings"
	"testing"

	"maunium.net/go/mautrix/event"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// A network's preview of a link travels in the sealed message, its picture as the owner's own
// stored copy, so the client can show it without anyone fetching the page.
func TestANetworksLinkPreviewIsSealedWithTheMessage(t *testing.T) {
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	c.Media = store
	o := &owner{userID: "alice"}
	picture := store.Upload([]byte("png bytes"), "", "image/png")
	msg := &event.MessageEventContent{
		MsgType: event.MsgText,
		Body:    "look https://example.com/a",
		BeeperLinkPreviews: []*event.BeeperLinkPreview{{
			MatchedURL: "https://example.com/a",
			LinkPreview: event.LinkPreview{
				Title: " A page ", Description: "What it's about", SiteName: "Example",
				ImageURL: picture, ImageWidth: 1200, ImageHeight: 630,
			},
		}},
	}
	plain := c.messagePlaintext(context.Background(), o, event.EventMessage, msg)
	if len(plain.Previews) != 1 {
		t.Fatalf("got %d previews", len(plain.Previews))
	}
	p := plain.Previews[0]
	if p.URL != "https://example.com/a" || p.Title != "A page" || p.Description != "What it's about" || p.SiteName != "Example" {
		t.Fatalf("preview: %+v", p)
	}
	if p.Image == nil || p.Image.MediaID == "" || p.Image.Key == "" || p.Image.Mime != "image/png" || p.Image.Width != 1200 {
		t.Fatalf("the picture must be the owner's stored copy: %+v", p.Image)
	}
}

func TestLinkPreviewsKeepOnlyWebLinksWithSomethingToShow(t *testing.T) {
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c := testConnector(t)
	c.Media = store
	o := &owner{userID: "alice"}
	file := store.Upload([]byte("not a picture"), "", "application/pdf")
	previews := []*event.BeeperLinkPreview{
		nil,
		{MatchedURL: "javascript:alert(1)", LinkPreview: event.LinkPreview{Title: "x"}},
		{MatchedURL: "mailto:a@b.test", LinkPreview: event.LinkPreview{Title: "x"}},
		{MatchedURL: "https://empty.test"},
		// The address written in the message wins over the canonical one; the canonical one is
		// kept when the network didn't say what was written.
		{MatchedURL: "example.com/a", LinkPreview: event.LinkPreview{CanonicalURL: "https://www.example.com/a", Title: "Written"}},
		{LinkPreview: event.LinkPreview{CanonicalURL: "https://www.example.com/b", Title: "Canonical"}},
		// Written without a scheme.
		{MatchedURL: "example.org", LinkPreview: event.LinkPreview{Title: "Schemeless"}},
	}
	got := c.linkPreviews(context.Background(), o, previews)
	want := []string{"https://example.com/a", "https://www.example.com/b", "https://example.org"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, p := range got {
		if p.URL != want[i] {
			t.Errorf("preview %d: %+v", i, p)
		}
	}
	previews = []*event.BeeperLinkPreview{
		// An expired picture, and one that isn't a picture, are left out; the words stay.
		{MatchedURL: "https://a.test", LinkPreview: event.LinkPreview{Title: "Gone", ImageURL: media.ContentURI("AAAAAAAAAAAAAAAAAAAAAA")}},
		{MatchedURL: "https://b.test", LinkPreview: event.LinkPreview{Title: "PDF", ImageURL: file}},
	}
	got = c.linkPreviews(context.Background(), o, previews)
	want = []string{"https://a.test", "https://b.test"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, p := range got {
		if p.URL != want[i] || p.Image != nil {
			t.Errorf("preview %d: %+v", i, p)
		}
	}
	// No more than three, and long words are cut.
	got = c.linkPreviews(context.Background(), o, []*event.BeeperLinkPreview{
		{MatchedURL: "https://1.test", LinkPreview: event.LinkPreview{Title: strings.Repeat("雪", 1000)}},
		{MatchedURL: "https://2.test", LinkPreview: event.LinkPreview{Title: "2"}},
		{MatchedURL: "https://3.test", LinkPreview: event.LinkPreview{Title: "3"}},
		{MatchedURL: "https://4.test", LinkPreview: event.LinkPreview{Title: "4"}},
	})
	if len(got) != maxPreviews || len(got[0].Title) > maxPreviewTitleBytes {
		t.Fatalf("got %d previews, first title %d bytes", len(got), len(got[0].Title))
	}
}

// Previews go before the body is cut: the links are still in the text.
func TestPreviewsGoBeforeTheBodyIsCut(t *testing.T) {
	body := strings.Repeat("a", protocol.MaxMessageSealedBytes-600)
	plain := &protocol.MessagePlaintext{Type: "text", Body: body, Previews: []protocol.LinkPreview{
		{URL: "https://example.com", Description: strings.Repeat("d", 1024)},
	}}
	fitMessage(plain)
	if plain.Previews != nil || plain.Body != body || !plain.Truncated {
		t.Fatalf("previews %d, body cut %v, truncated %v", len(plain.Previews), plain.Body != body, plain.Truncated)
	}
}

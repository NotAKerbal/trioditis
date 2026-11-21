package connector

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

func TestTruncateUTF8KeepsWholeCharacters(t *testing.T) {
	long := strings.Repeat("雪", 3000) // 3 bytes each
	got := truncateUTF8(long, maxTopicBytes)
	if len(got) > maxTopicBytes || !utf8.ValidString(got) {
		t.Fatalf("got %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if truncateUTF8("short", maxNameBytes) != "short" {
		t.Fatal("a short string must be left alone")
	}
}

func sealedLen(t *testing.T, v any) int {
	t.Helper()
	kp, err := seal.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	env, err := seal.SealJSON(v, []seal.PublicKey{kp.Public}, seal.Context{Kind: seal.KindChat, OwnerUserID: "u", ObjectID: "o"})
	if err != nil {
		t.Fatal(err)
	}
	return seal.DecodedLen(env.CT)
}

// A control character is one byte in but six once JSON-escaped, so a 4 KiB topic of them
// would seal to far more than 8 KiB if only input bytes were counted.
func TestEscapedMetadataSealsWithinItsLimit(t *testing.T) {
	chat := protocol.ChatPlaintext{Name: strings.Repeat("\x01", 4000), Topic: strings.Repeat("\x01", 4096)}
	fitChat(&chat)
	if n := sealedLen(t, chat); n > protocol.MaxMetadataSealedBytes {
		t.Fatalf("chat seals to %d bytes", n)
	}
	if chat.Name == "" {
		t.Fatal("the topic is cut before the name")
	}
	contact := protocol.ContactPlaintext{Name: strings.Repeat("\"", 4000), Handle: strings.Repeat("<", 4000)}
	fitContact(&contact)
	if n := sealedLen(t, contact); n > protocol.MaxMetadataSealedBytes {
		t.Fatalf("contact seals to %d bytes", n)
	}
	short := protocol.ChatPlaintext{Name: "Family", Topic: "Weekend plans"}
	fitChat(&short)
	if short.Name != "Family" || short.Topic != "Weekend plans" {
		t.Fatal("short metadata must be left alone")
	}
}

func TestOversizedMessageIsTruncatedToFit(t *testing.T) {
	for _, body := range []string{strings.Repeat("雪", 120*1024), strings.Repeat("\x02", 200*1024)} {
		plain := fitMessage(&protocol.MessagePlaintext{
			Type: "file", Body: body, HTML: strings.Repeat("<b>x</b>", 1000),
			Attachments: []protocol.Attachment{{MediaID: "m", Mime: "text/plain", Name: body, Key: "k", Nonce: "n"}},
		})
		if n := sealedLen(t, plain); n > protocol.MaxMessageSealedBytes {
			t.Fatalf("message seals to %d bytes", n)
		}
		if !plain.Truncated || plain.HTML != "" || plain.Body == "" || !utf8.ValidString(plain.Body) || !strings.HasPrefix(body, plain.Body) {
			t.Fatalf("expected a truncated prefix of the body without HTML, got truncated=%v html=%d body=%d", plain.Truncated, len(plain.HTML), len(plain.Body))
		}
	}
	plain := fitMessage(&protocol.MessagePlaintext{Type: "text", Body: "hello", HTML: "<b>hello</b>"})
	if plain.Truncated || plain.HTML == "" {
		t.Fatal("a small message must be left alone")
	}
}

func TestIdentifiersAreKeptWholeAndFit(t *testing.T) {
	var idents []string
	for i := range 40 {
		idents = append(idents, fmt.Sprintf("tel:+1555%07d%s", i, strings.Repeat("<", 60)))
	}
	idents = append([]string{"telegram:" + strings.Repeat("x", 600), idents[0]}, idents...)
	got := fitIdentifiers(idents)
	if n := sealedLen(t, protocol.ContactIdentifiersPlaintext{Identifiers: got}); n > protocol.MaxMetadataSealedBytes {
		t.Fatalf("identifiers seal to %d bytes", n)
	}
	// The overlong one and the repeat are dropped, and the rest kept in order until they don't fit.
	if len(got) == 0 || len(got) >= maxIdentifiers || got[0] != idents[1] || got[1] != idents[3] {
		t.Fatalf("kept %d identifiers, starting %q", len(got), got[:min(2, len(got))])
	}
}

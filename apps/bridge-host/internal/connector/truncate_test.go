package connector

import (
	"strings"
	"testing"
	"unicode/utf8"
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

package connector

import (
	"errors"
	"slices"
	"testing"

	"maunium.net/go/mautrix/bridgev2/networkid"
)

func TestACollageShowsMembersWithAPictureFirst(t *testing.T) {
	pictures := map[networkid.UserID]bool{"erin": true, "bob": true}
	hasPicture := func(g networkid.UserID) (bool, error) { return pictures[g], nil }
	isSelf := func(g networkid.UserID) bool { return g == "alice" }
	members := []networkid.UserID{"frank", "dave", "alice", "erin", "carol", "bob", "dave"}

	got, err := chooseCollage(members, isSelf, hasPicture)
	if err != nil {
		t.Fatal(err)
	}
	// Pictured first, then the rest, each in ID order; never the person, never twice.
	if want := []networkid.UserID{"bob", "erin", "carol", "dave"}; !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	// The members' order doesn't change the choice.
	slices.Reverse(members)
	if again, _ := chooseCollage(members, isSelf, hasPicture); !slices.Equal(again, got) {
		t.Fatalf("a different order chose %q", again)
	}
}

func TestACollageOfAChatWithOnlyThePersonIsEmpty(t *testing.T) {
	got, err := chooseCollage([]networkid.UserID{"alice"}, func(g networkid.UserID) bool { return g == "alice" },
		func(networkid.UserID) (bool, error) { return true, nil })
	if err != nil || len(got) != 0 {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestACollageLooksAtABoundedNumberOfMembers(t *testing.T) {
	var members []networkid.UserID
	for i := range collageScan + 10 {
		members = append(members, networkid.UserID(string(rune('a'+i/26/26%26))+string(rune('a'+i/26%26))+string(rune('a'+i%26))))
	}
	looked := 0
	// Only the last members, past the bound, have pictures: none is looked at.
	pictured := members[collageScan:]
	got, err := chooseCollage(members, func(networkid.UserID) bool { return false }, func(g networkid.UserID) (bool, error) {
		looked++
		return slices.Contains(pictured, g), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if looked != collageScan {
		t.Fatalf("looked at %d members, want %d", looked, collageScan)
	}
	if !slices.Equal(got, members[:collageSize]) {
		t.Fatalf("got %q", got)
	}
}

func TestACollageStopsOnceItHasEnoughPictures(t *testing.T) {
	looked := 0
	got, err := chooseCollage([]networkid.UserID{"a", "b", "c", "d", "e", "f"}, func(networkid.UserID) bool { return false },
		func(networkid.UserID) (bool, error) { looked++; return true, nil })
	if err != nil || len(got) != collageSize || looked != collageSize {
		t.Fatalf("got %q after looking at %d: %v", got, looked, err)
	}
	failure := errors.New("database gone")
	if _, err = chooseCollage([]networkid.UserID{"a"}, func(networkid.UserID) bool { return false },
		func(networkid.UserID) (bool, error) { return false, failure }); !errors.Is(err, failure) {
		t.Fatalf("a lookup's failure was lost: %v", err)
	}
}

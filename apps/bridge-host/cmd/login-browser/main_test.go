package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestReadMessage(t *testing.T) {
	br := bufio.NewReaderSize(strings.NewReader("one\x00two\x00"), 16)
	for _, want := range []string{"one", "two"} {
		if got, err := readMessage(br); err != nil || string(got) != want {
			t.Fatalf("readMessage = %q, %v; want %q", got, err, want)
		}
	}
	big := bufio.NewReaderSize(bytes.NewReader(append(bytes.Repeat([]byte("x"), maxMessage+1), 0)), 1<<20)
	if _, err := readMessage(big); !errors.Is(err, errTooLarge) {
		t.Fatalf("a message over the limit: %v", err)
	}
}

func TestUsersAreNeverReused(t *testing.T) {
	first, last, err := userRange("20001-20003")
	if err != nil {
		t.Fatal(err)
	}
	pool := &userPool{next: first, last: last}
	seen := map[int]bool{}
	for range 3 {
		uid, ok := pool.take()
		if !ok || seen[uid] {
			t.Fatalf("take = %d, %v", uid, ok)
		}
		seen[uid] = true
	}
	if _, ok := pool.take(); ok {
		t.Fatal("a user was handed out twice")
	}
	for _, bad := range []string{"", "0-10", "20003-20001", "a-b", "20001"} {
		if _, _, err := userRange(bad); err == nil {
			t.Errorf("userRange(%q) was taken", bad)
		}
	}
}

func TestAdmissionDrains(t *testing.T) {
	var a admission
	if !a.admit() || !a.admit() {
		t.Fatal("not admitted")
	}
	idle := a.drain()
	if a.admit() {
		t.Fatal("admitted while draining")
	}
	a.release()
	select {
	case <-idle:
		t.Fatal("idle with a browser still being served")
	default:
	}
	a.release()
	<-idle
	// Draining again, with nothing served, is already idle.
	<-a.drain()
}

func TestOnePersonCantTakeEverySlot(t *testing.T) {
	l := &launcher{perPerson: 1, owners: map[string][]*ownerSession{}}
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	session := func() (*ownerSession, chan struct{}) {
		ended := make(chan struct{})
		var once sync.Once
		return &ownerSession{cancel: func() { once.Do(func() { close(ended) }) }, done: make(chan struct{})}, ended
	}
	first, firstEnded := session()
	if !l.takeOwner(context.Background(), a, first) {
		t.Fatal("refused")
	}
	other, _ := session()
	if !l.takeOwner(context.Background(), b, other) {
		t.Fatal("someone else was refused")
	}
	// The same person again: their older browser is ended to make room.
	go func() {
		<-firstEnded
		l.releaseOwner(a, first)
	}()
	second, _ := session()
	if !l.takeOwner(context.Background(), a, second) {
		t.Fatal("a person starting again was refused")
	}
	select {
	case <-first.done:
	default:
		t.Fatal("the older browser wasn't ended")
	}
	if len(l.owners[a]) != 1 || len(l.owners[b]) != 1 {
		t.Fatalf("owners = %v", l.owners)
	}
	// A request that has already gone ends nobody's browser: the person's current one (second)
	// isn't asked to end.
	secondEnded := make(chan struct{})
	second.cancel = func() { close(secondEnded) }
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	third, _ := session()
	if l.takeOwner(gone, a, third) {
		t.Fatal("a request that had gone was given a browser")
	}
	select {
	case <-secondEnded:
		t.Fatal("a request that had gone ended the person's browser")
	default:
	}
	// One that goes while it waits for the person's browser to end gives up, and takes nothing.
	waiting, stopWaiting := context.WithCancel(context.Background())
	result := make(chan bool)
	fourth, _ := session()
	go func() { result <- l.takeOwner(waiting, a, fourth) }()
	<-secondEnded
	stopWaiting()
	if <-result {
		t.Fatal("a request that went while waiting was given a browser")
	}
	if len(l.owners[a]) != 1 || l.owners[a][0] != second {
		t.Fatal("a request that had gone ended the person's browser")
	}
	if ownerName.MatchString("user_a") || !ownerName.MatchString(a) {
		t.Error("owner names aren't checked")
	}
}

package connector

import (
	"context"
	"testing"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// testAccounts are the logins the tests' bridgev2 runs, by network login ID (cachedLogin).
var testAccounts = map[networkid.UserLoginID]*bridgev2.UserLogin{}

func testAccount(id networkid.UserLoginID, userID string) *bridgev2.UserLogin {
	login := &bridgev2.UserLogin{UserLogin: &database.UserLogin{ID: id, UserMXID: ids.UserMXID(userID)}}
	testAccounts[id] = login
	return login
}

func useTestAccounts(t *testing.T) {
	old := cachedLogin
	cachedLogin = func(_ *bridgev2.Bridge, id networkid.UserLoginID) *bridgev2.UserLogin { return testAccounts[id] }
	t.Cleanup(func() { cachedLogin = old })
}

// A cancelled login's kept record goes only once its logout has finished, and a kept account
// is logged out only while it is still that login's and the same person's.
func TestADiscardedAccountIsLoggedOutOnlyWhileStillThatLoginsAndPersons(t *testing.T) {
	useTestAccounts(t)
	ctx := context.Background()
	var done []func()
	var loggedOut []networkid.UserLoginID
	old := logoutDiscarded
	logoutDiscarded = func(_ context.Context, login *bridgev2.UserLogin, finished func()) {
		loggedOut = append(loggedOut, login.ID)
		done = append(done, finished)
	}
	t.Cleanup(func() { logoutDiscarded = old })
	kept := func(c *Connector) int {
		rows, err := c.Store.Discarded(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}

	// Still the cancelled login's: logged out, and the record kept until the logout returns.
	c := testConnector(t)
	testAccount("acct-1", "alice")
	if err := c.Store.PutActivation(ctx, "acct-1", store.Activation{SessionID: "cancelled", UserID: "alice"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Store.PutDiscarded(ctx, store.DiscardedLogin{SessionID: "cancelled", UserID: "alice", LoginID: "acct-1"}); err != nil {
		t.Fatal(err)
	}
	if err := c.SettleDiscardedAtStart(ctx); err != nil {
		t.Fatal(err)
	}
	if len(loggedOut) != 1 || kept(c) != 1 {
		t.Fatalf("logouts %v, kept %d; want one logout, record still kept", loggedOut, kept(c))
	}
	done[0]()
	if kept(c) != 0 {
		t.Fatal("the record outlived the finished logout")
	}

	// Another member's now (the account was connected again by someone else): left alone.
	loggedOut = nil
	c = testConnector(t)
	testAccount("acct-2", "bob")
	if err := c.Store.PutActivation(ctx, "acct-2", store.Activation{SessionID: "bobs", UserID: "bob"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Store.PutDiscarded(ctx, store.DiscardedLogin{SessionID: "cancelled", UserID: "alice", LoginID: "acct-2"}); err != nil {
		t.Fatal(err)
	}
	if err := c.SettleDiscardedAtStart(ctx); err != nil {
		t.Fatal(err)
	}
	if len(loggedOut) != 0 || kept(c) != 0 {
		t.Fatalf("another member's account: logouts %v, kept %d", loggedOut, kept(c))
	}

	// The same person's, but a later activation (they connected it again themselves): left.
	c = testConnector(t)
	testAccount("acct-3", "alice")
	if err := c.Store.PutActivation(ctx, "acct-3", store.Activation{SessionID: "later", UserID: "alice"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Store.PutDiscarded(ctx, store.DiscardedLogin{SessionID: "cancelled", UserID: "alice", LoginID: "acct-3"}); err != nil {
		t.Fatal(err)
	}
	if err := c.SettleDiscardedAtStart(ctx); err != nil {
		t.Fatal(err)
	}
	if len(loggedOut) != 0 || kept(c) != 0 {
		t.Fatalf("a later activation: logouts %v, kept %d", loggedOut, kept(c))
	}

	// Bridgev2 runs it for someone else, even with the activation still the cancelled one's.
	c = testConnector(t)
	testAccount("acct-4", "bob")
	if err := c.Store.PutActivation(ctx, "acct-4", store.Activation{SessionID: "cancelled", UserID: "alice"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Store.PutDiscarded(ctx, store.DiscardedLogin{SessionID: "cancelled", UserID: "alice", LoginID: "acct-4"}); err != nil {
		t.Fatal(err)
	}
	if err := c.SettleDiscardedAtStart(ctx); err != nil {
		t.Fatal(err)
	}
	if len(loggedOut) != 0 || kept(c) != 0 {
		t.Fatalf("someone else's login: logouts %v, kept %d", loggedOut, kept(c))
	}
}

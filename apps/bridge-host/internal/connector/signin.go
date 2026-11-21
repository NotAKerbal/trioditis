package connector

import (
	"context"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
)

// OpenBrowser is the sign-in browser for a login's current cookie step, for the person
// whose login it is, started if it isn't running (docs/architecture/signin-browser.md).
func (c *Connector) OpenBrowser(_ context.Context, loginSessionID, userID, stepID string) (*signin.Browser, error) {
	if c.Signin == nil {
		return nil, conflict(protocol.ErrUnsupported, "this bridge host has no sign-in browser")
	}
	raw, ok := c.logins.Load(loginSessionID)
	if !ok {
		return nil, conflict(protocol.ErrInvalidCommand, "unknown login session")
	}
	s := raw.(*loginSession)
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.userID != userID {
		return nil, conflict(protocol.ErrInvalidCommand, "login session belongs to someone else")
	}
	step := s.step
	if s.done || step == nil || s.stepID != stepID || s.submitted == stepID ||
		step.Type != bridgev2.LoginStepTypeCookies || step.CookiesParams == nil || step.CookiesParams.Hidden {
		return nil, conflict(protocol.ErrInvalidCommand, "that login step isn't a current cookie step")
	}
	if s.browser == nil || s.browser.Closed() {
		s.browser = s.newBrowser(stepID, step)
	}
	return s.browser, nil
}

// runHidden starts a hidden cookie step's browser, which needs nobody to watch it.
func (s *loginSession) runHidden(stepID string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.done || s.stepID != stepID || s.step == nil {
		return
	}
	s.browser = s.newBrowser(stepID, s.step)
	s.browser.Run()
}

// newBrowser makes a cookie step's browser, which submits what it collects as the step's
// input, as a pasted step's would be. Called with s.lock.
func (s *loginSession) newBrowser(stepID string, step *bridgev2.LoginStep) *signin.Browser {
	return s.c.Signin.New(step.CookiesParams, signin.Owner(s.userID), func(values map[string]string) {
		if !s.claim(stepID) {
			clear(values)
			return
		}
		s.submitInput(step, values, true)
	}, func(err error) {
		// A hidden step that can't finish would leave the person waiting for good.
		if s.claim(stepID) {
			s.advance(nil, err)
		}
	})
}

// claim takes stepID's one submission for the browser, if it is still the current step and
// nothing has been submitted for it.
func (s *loginSession) claim(stepID string) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.done || s.step == nil || s.stepID != stepID || s.submitted == stepID {
		return false
	}
	s.submitted = stepID
	s.c.browserSteps.Store(s.id+"/"+stepID, struct{}{})
	return true
}

// closeBrowser ends the current browser, if there is one. Called with s.lock; the browser
// closes in the background, since closing waits on its viewer's connection.
func (s *loginSession) closeBrowser() {
	if b := s.browser; b != nil {
		s.browser = nil
		go b.Close()
	}
}

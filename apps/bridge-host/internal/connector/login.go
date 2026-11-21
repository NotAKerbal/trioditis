package connector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/url"
	"slices"
	"sync"
	"time"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
)

// loginSession is one run of a network's login flow, driven by loginStart, loginSubmit and
// loginCancel commands. The flow lives in memory, but a row in the store records that it is
// in progress until its last step is reported, so a restart ends it with an error the
// person sees (RecoverLogins) rather than leaving it waiting.
type loginSession struct {
	c       *Connector
	id      string
	userID  string
	process bridgev2.LoginProcess
	ctx     context.Context
	cancel  context.CancelFunc

	lock   sync.Mutex
	step   *bridgev2.LoginStep
	stepID string
	// submitted is the step whose input is being handled. One submit per step: a second,
	// even with a different command ID, is refused.
	submitted string
	done      bool
	// browser is the current cookie step's sign-in browser, once someone opens it.
	browser *signin.Browser
}

func randomStepID() string {
	b := make([]byte, 12)
	_, _ = io.ReadFull(rand.Reader, b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *Connector) handleLoginStart(ctx context.Context, cmd *protocol.Command, check bool) error {
	if cmd.LoginSessionID == "" || cmd.UserID == "" {
		return badRequest("loginSessionId and userId are required")
	}
	if cmd.Network != "" && cmd.Network != c.Network {
		return badRequest("this bridge host serves %s, not %s", c.Network, cmd.Network)
	}
	if _, exists := c.logins.Load(cmd.LoginSessionID); exists {
		return nil
	}
	// Nothing may be bridged for someone the bridge host can't seal to.
	if has, err := c.Keys.Has(ctx, cmd.UserID); err != nil {
		return err
	} else if !has {
		return conflict(protocol.ErrInvalidCommand, "the person has no identity key yet, so a login can't start")
	}
	if check {
		return nil
	}
	user, err := c.Bridge.GetUserByMXID(ctx, ids.UserMXID(cmd.UserID))
	if err != nil {
		return err
	}
	flowID := cmd.FlowID
	if flowID == "" {
		flows := c.Bridge.Network.GetLoginFlows()
		if len(flows) == 0 {
			return conflict(protocol.ErrUnsupported, "the network has no login flows")
		}
		flowID = flows[0].ID
	}
	process, err := c.Bridge.Network.CreateLogin(ctx, user, flowID)
	if err != nil {
		return &CommandError{Status: 409, Code: protocol.ErrLoginFailed, Detail: fmt.Sprintf("can't start login: %T", err)}
	}
	if err = c.Store.PutLoginSession(ctx, cmd.LoginSessionID, cmd.UserID); err != nil {
		process.Cancel()
		return err
	}
	sessionCtx, cancel := context.WithCancel(c.Bridge.BackgroundCtx)
	s := &loginSession{c: c, id: cmd.LoginSessionID, userID: cmd.UserID, process: process, ctx: sessionCtx, cancel: cancel}
	c.logins.Store(s.id, s)
	go func() {
		step, err := process.Start(sessionCtx)
		s.advance(step, err)
	}()
	return nil
}

func (c *Connector) handleLoginSubmit(ctx context.Context, cmd *protocol.Command, check bool) error {
	// The sign-in browser may have submitted this step while the person was pasting it: the
	// browser's submission goes on, and the pasted one is taken and dropped, unopened, even
	// once the login has moved past the step or ended. Refusing it would end the login with an
	// error if the backend hasn't heard of the browser's outcome yet. The browser claims a
	// step under the login's lock, so it is asked again wherever this could still refuse.
	browserWon := func() bool {
		_, won := c.browserSteps.Load(cmd.LoginSessionID + "/" + cmd.StepID)
		return won
	}
	if browserWon() {
		return nil
	}
	raw, ok := c.logins.Load(cmd.LoginSessionID)
	if !ok {
		if browserWon() {
			return nil
		}
		// A login recorded as in progress but not running here was lost (a restart): the
		// person is waiting on it, so it ends with an error they see. One that has simply
		// ended (a second submit after it completed) is only refused.
		// One this process ended is over, not lost, even in the moment before its record is
		// deleted.
		if _, ended := c.endedLogins.Load(cmd.LoginSessionID); ended {
			return conflict(protocol.ErrInvalidCommand, "the login is over")
		}
		lost, err := c.Store.HasLoginSession(ctx, cmd.LoginSessionID)
		if err != nil {
			return err
		} else if !lost {
			return conflict(protocol.ErrInvalidCommand, "unknown login session")
		}
		if err = c.endLoginWithError(ctx, cmd.UserID, cmd.LoginSessionID, protocol.ErrLoginFailed); err != nil {
			return err
		}
		return conflict(protocol.ErrLoginFailed, "the login was lost")
	}
	s := raw.(*loginSession)
	if s.userID != cmd.UserID {
		return conflict(protocol.ErrInvalidCommand, "login session belongs to someone else")
	}
	var plain protocol.LoginSubmitPlaintext
	if err := c.openOutbound(cmd, cmd.UserID, cmd.LoginSessionID+"/"+cmd.StepID, &plain); err != nil {
		return err
	}
	s.lock.Lock()
	if browserWon() {
		s.lock.Unlock()
		clear(plain.Input)
		return nil
	}
	step, stepID := s.step, s.stepID
	current := step != nil && stepID == cmd.StepID && s.submitted != stepID
	if current && !check {
		s.submitted = stepID
		// Pasted first: the browser has nothing more to do.
		s.closeBrowser()
	}
	s.lock.Unlock()
	if !current {
		clear(plain.Input)
		return conflict(protocol.ErrInvalidCommand, "that login step isn't the current one")
	} else if check {
		clear(plain.Input)
		return nil
	}
	go s.submitInput(step, plain.Input, false)
	return nil
}

// submitInput hands a step's input to the network and moves the login on with what it
// answers. The input is a credential: it is cleared once used. decoded says its cookies are
// already percent-decoded, as the sign-in browser's are.
func (s *loginSession) submitInput(step *bridgev2.LoginStep, input map[string]string, decoded bool) {
	var next *bridgev2.LoginStep
	var err error
	switch step.Type {
	case bridgev2.LoginStepTypeUserInput:
		proc, ok := s.process.(bridgev2.LoginProcessUserInput)
		if !ok {
			err = errors.New("login process doesn't accept input")
			break
		}
		next, err = proc.SubmitUserInput(s.ctx, input)
	case bridgev2.LoginStepTypeCookies:
		proc, ok := s.process.(bridgev2.LoginProcessCookies)
		if !ok {
			err = errors.New("login process doesn't accept cookies")
			break
		}
		// A cookie left blank is an optional one the person doesn't have. Connectors put
		// every cookie they are given into their requests, so it isn't passed on empty.
		maps.DeleteFunc(input, func(_, value string) bool { return value == "" })
		if !decoded {
			decodeCookies(step.CookiesParams, input)
		}
		next, err = proc.SubmitCookies(s.ctx, input)
	default:
		err = errors.New("the current login step doesn't take input")
	}
	// The input is a credential; drop the only copy as soon as it's used.
	clear(input)
	s.advance(next, err)
}

func (c *Connector) handleLoginCancel(ctx context.Context, cmd *protocol.Command, check bool) error {
	raw, ok := c.logins.Load(cmd.LoginSessionID)
	if !ok {
		return nil
	}
	s := raw.(*loginSession)
	if s.userID != cmd.UserID {
		return conflict(protocol.ErrInvalidCommand, "login session belongs to someone else")
	} else if check {
		return nil
	}
	if !c.logins.CompareAndDelete(cmd.LoginSessionID, s) {
		return nil
	}
	c.endedLogins.Store(s.id, struct{}{})
	// The login may have completed at the same moment: whichever ends it first is the outcome
	// reported, and the other changes nothing (a completion that loses is reported afterCancel,
	// see advance).
	if !s.finish() {
		return nil
	}
	return s.end(&protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepCancelled})
}

// finish ends the login, unless something else already did. It reports whether this call
// ended it, so exactly one last step is reported.
func (s *loginSession) finish() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.done {
		return false
	}
	s.done = true
	s.cancel()
	s.process.Cancel()
	s.closeBrowser()
	return true
}

// maxLoginStepBytes is the most a login step may hold, as the backend requires.
const maxLoginStepBytes = 64 * 1024

func (s *loginSession) emit(step *protocol.LoginStep) error {
	if data, err := json.Marshal(step); err == nil && len(data) > maxLoginStepBytes {
		// A network asking to show something this big can't be shown; the login ends instead.
		s.c.forgetLogin(s.id)
		if !s.finish() {
			return nil
		}
		return s.end(&protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepError, Error: protocol.ErrLoginFailed})
	}
	return s.c.emit(s.c.Bridge.BackgroundCtx, &protocol.Event{
		Type: protocol.EventLoginStep, UserID: s.userID, LoginID: step.LoginID, LoginSessionID: s.id, Step: step,
	})
}

// end reports a login's last step and records that it is no longer in progress, together.
func (s *loginSession) end(step *protocol.LoginStep) error {
	return s.c.endLogin(s.c.Bridge.BackgroundCtx, s.userID, s.id, step)
}

// endLogin reports a login's last step and forgets that it was in progress, in one
// transaction, so a restart neither ends it twice nor misses it.
func (c *Connector) endLogin(ctx context.Context, userID, loginSessionID string, step *protocol.LoginStep) error {
	evt := &protocol.Event{
		Type: protocol.EventLoginStep, UserID: userID, LoginID: step.LoginID, LoginSessionID: loginSessionID, Step: step,
		At: time.Now().UnixMilli(),
	}
	err := c.Store.Txn(ctx, func(ctx context.Context) error {
		if _, err := c.Store.DeleteLoginSession(ctx, loginSessionID); err != nil {
			return err
		}
		return c.Store.Append(ctx, evt)
	})
	if err == nil {
		c.Notify()
	}
	return err
}

// advance records the step the network returned and reports it. A display-and-wait step
// keeps waiting in the background until the network moves on.
func (s *loginSession) advance(step *bridgev2.LoginStep, err error) {
	log := s.c.Log.With().Str("login_session_id", s.id).Logger()
	if err == nil && step == nil {
		err = errors.New("login process returned no step")
	}
	completed := err == nil && step.Type == bridgev2.LoginStepTypeComplete
	stepID := ""
	if err == nil {
		if stepID = step.TxnID; stepID == "" {
			stepID = randomStepID()
		}
	}
	// Checked and claimed in one go, so a cancel can't slip in between: either the cancel ended
	// the login first and this step changes nothing, or a completion has claimed it and the
	// cancel does.
	s.lock.Lock()
	if s.done {
		s.lock.Unlock()
		if completed {
			s.reportAfterCancel(step)
		}
		return
	}
	if completed {
		s.done = true
	}
	if err == nil {
		s.step, s.stepID = step, stepID
		// The last step's browser has nothing more to do.
		s.closeBrowser()
	}
	s.lock.Unlock()
	if err != nil {
		s.c.forgetLogin(s.id)
		if !s.finish() {
			return
		}
		// Only the error's type is logged: a connector's error text can quote what the person
		// typed. The person sees a code.
		log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Login failed")
		code := protocol.ErrLoginFailed
		if errors.Is(err, context.DeadlineExceeded) {
			code = protocol.ErrTimeout
		}
		if emitErr := s.end(&protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepError, Error: code}); emitErr != nil {
			log.Err(emitErr).Msg("Failed to report login error")
		}
		return
	}
	out := &protocol.LoginStep{StepID: stepID, Instructions: step.Instructions}
	switch step.Type {
	case bridgev2.LoginStepTypeDisplayAndWait:
		out.Type = protocol.StepDisplayAndWait
		if p := step.DisplayAndWaitParams; p != nil {
			out.Display = &protocol.LoginDisplay{Type: string(p.Type), Data: p.Data}
			if p.Data != "" {
				out.Display.ExpiresAt = time.Now().Add(DisplayLifetime).UnixMilli()
			}
		}
	case bridgev2.LoginStepTypeUserInput:
		out.Type = protocol.StepUserInput
		if p := step.UserInputParams; p != nil {
			for _, f := range p.Fields {
				out.Fields = append(out.Fields, protocol.LoginField{
					ID: f.ID, Type: string(f.Type), Name: f.Name, Description: f.Description, Pattern: f.Pattern,
				})
			}
		}
	case bridgev2.LoginStepTypeCookies:
		out.Type = protocol.StepCookies
		if p := step.CookiesParams; p != nil {
			out.Cookies = &protocol.LoginCookies{URL: p.URL, UserAgent: p.UserAgent, Browser: s.c.Signin != nil, Hidden: p.Hidden}
			for _, f := range p.Fields {
				out.Cookies.Fields = append(out.Cookies.Fields, protocol.LoginCookieField{ID: f.ID, Required: f.Required})
			}
		}
	case bridgev2.LoginStepTypeComplete:
		out.Type = protocol.StepComplete
		// A connector's closing words name the account ("Logged into <workspace> as
		// <email>"), and steps are kept by the backend and the journal in plaintext. The app
		// says it's connected in its own words.
		out.Instructions = ""
		if p := step.CompleteParams; p != nil {
			loginID, err := s.c.loginOpaque(s.c.Bridge.BackgroundCtx, p.UserLoginID)
			if err != nil {
				log.Err(err).Msg("Failed to record login ID")
			}
			out.LoginID = loginID
		}
		// Claimed above, so a cancel from here on leaves it complete.
		s.c.forgetLogin(s.id)
		s.cancel()
	default:
		s.advance(nil, errors.New("this login step type isn't supported: "+string(step.Type)))
		return
	}
	report := s.emit
	if out.Type == protocol.StepComplete {
		report = s.end
	}
	if err := report(out); err != nil {
		log.Err(err).Msg("Failed to report login step")
	}
	if out.Display != nil && out.Display.ExpiresAt != 0 {
		go s.keepDisplay(stepID, out)
	}
	if p := step.CookiesParams; step.Type == bridgev2.LoginStepTypeCookies && p != nil && p.Hidden && s.c.Signin != nil {
		s.runHidden(stepID)
	}
	if step.Type == bridgev2.LoginStepTypeDisplayAndWait {
		proc, ok := s.process.(bridgev2.LoginProcessDisplayAndWait)
		if !ok {
			s.advance(nil, errors.New("login process can't wait"))
			return
		}
		go func() {
			next, err := proc.Wait(s.ctx)
			s.advance(next, err)
		}()
	}
}

// DisplayLifetime is how long a QR or pairing code is shown without the bridge host saying it
// is still good. While the code is the login's current step the host says so every half of
// it, so a code only disappears early when the host has stopped, or the login has moved on.
var DisplayLifetime = 90 * time.Second

// keepDisplay reports a display step again, with its expiry moved on, every half of
// DisplayLifetime for as long as it is the login's current step. It reports under the login's
// lock, so it can't land after the step that replaces it.
func (s *loginSession) keepDisplay(stepID string, step *protocol.LoginStep) {
	ticker := time.NewTicker(DisplayLifetime / 2)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		s.lock.Lock()
		if s.done || s.stepID != stepID {
			s.lock.Unlock()
			return
		}
		display := *step.Display
		display.ExpiresAt = time.Now().Add(DisplayLifetime).UnixMilli()
		refreshed := *step
		refreshed.Display = &display
		err := s.c.emit(s.c.Bridge.BackgroundCtx, &protocol.Event{
			Type: protocol.EventLoginStep, UserID: s.userID, LoginSessionID: s.id, Step: &refreshed,
		})
		s.lock.Unlock()
		if err != nil {
			s.c.Log.Err(err).Str("login_session_id", s.id).Msg("Failed to report that a login code is still good")
		}
	}
}

// reportAfterCancel says a login the person cancelled connected an account anyway, as a
// `complete` step marked afterCancel. The account isn't logged out on the host's own say: that
// guessed wrong too often (a retry of theirs connecting the same account). It is kept and
// reported as connected, and the backend flags it so the person decides whether to keep it.
func (s *loginSession) reportAfterCancel(step *bridgev2.LoginStep) {
	p := step.CompleteParams
	if p == nil || p.UserLoginID == "" {
		return
	}
	ctx := context.WithoutCancel(s.c.Bridge.BackgroundCtx)
	loginID, err := s.c.loginOpaque(ctx, p.UserLoginID)
	if err != nil {
		s.c.Log.Err(err).Str("login_session_id", s.id).Msg("Failed to record login ID")
		return
	}
	s.c.Log.Info().Str("login_session_id", s.id).Msg("A login completed after it was cancelled; keeping the account for the person to decide")
	if err = s.c.emit(ctx, &protocol.Event{
		Type: protocol.EventLoginStep, UserID: s.userID, LoginID: loginID, LoginSessionID: s.id,
		Step: &protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepComplete, LoginID: loginID, AfterCancel: true},
	}); err != nil {
		s.c.Log.Err(err).Str("login_session_id", s.id).Msg("Failed to report a login that completed after it was cancelled")
	}
}

// decodeCookies percent-decodes what was read from a browser cookie, as bridgev2's own cookie
// login does: developer tools show a cookie as the browser sends it, percent-encoded, and
// connectors expect it decoded (Slack's encodes its cookie again, so an encoded one fails).
// A value with no percent-escapes, as pasted already decoded, is left as it is.
func decodeCookies(params *bridgev2.LoginCookiesParams, input map[string]string) {
	if params == nil {
		return
	}
	for _, field := range params.Fields {
		value := input[field.ID]
		isCookie := slices.ContainsFunc(field.Sources, func(src bridgev2.LoginCookieFieldSource) bool {
			return src.Type == bridgev2.LoginCookieTypeCookie
		})
		if value == "" || !isCookie {
			continue
		}
		if decoded, err := url.PathUnescape(value); err == nil {
			input[field.ID] = decoded
		}
	}
}

// endLoginWithError ends a login the person was promised would go ahead (its command got a
// 202) but that can't: a restart lost it, or its command couldn't run. Ending one that has
// already ended does no harm: the backend ignores steps for a login that is over.
func (c *Connector) endLoginWithError(ctx context.Context, userID, loginSessionID, code string) error {
	if loginSessionID == "" {
		return nil
	}
	c.endedLogins.Store(loginSessionID, struct{}{})
	if raw, ok := c.logins.LoadAndDelete(loginSessionID); ok {
		raw.(*loginSession).finish()
	}
	return c.endLogin(ctx, userID, loginSessionID, &protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepError, Error: code})
}

// forgetLogin stops running a login. It is remembered as ended (by this process), so a submit
// arriving before its record is deleted isn't taken for a login a restart lost.
func (c *Connector) forgetLogin(id string) {
	c.endedLogins.Store(id, struct{}{})
	c.logins.Delete(id)
}

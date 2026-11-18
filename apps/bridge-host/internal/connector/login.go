package connector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"sync"

	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// loginSession is one run of a network's login flow, driven by loginStart, loginSubmit and
// loginCancel commands. Sessions live in memory: a login interrupted by a restart is
// started again by the person.
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
	done   bool
}

func randomStepID() string {
	b := make([]byte, 12)
	_, _ = io.ReadFull(rand.Reader, b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *Connector) handleLoginStart(ctx context.Context, cmd *protocol.Command) error {
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
		return conflict("the person has no identity key yet, so a login can't start")
	}
	user, err := c.Bridge.GetUserByMXID(ctx, ids.UserMXID(cmd.UserID))
	if err != nil {
		return err
	}
	flowID := cmd.FlowID
	if flowID == "" {
		flows := c.Bridge.Network.GetLoginFlows()
		if len(flows) == 0 {
			return conflict("the network has no login flows")
		}
		flowID = flows[0].ID
	}
	process, err := c.Bridge.Network.CreateLogin(ctx, user, flowID)
	if err != nil {
		return badRequest("can't start login: %v", err)
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

func (c *Connector) handleLoginSubmit(ctx context.Context, cmd *protocol.Command) error {
	raw, ok := c.logins.Load(cmd.LoginSessionID)
	if !ok {
		return conflict("unknown login session")
	}
	s := raw.(*loginSession)
	if s.userID != cmd.UserID {
		return conflict("login session belongs to someone else")
	}
	var plain protocol.LoginSubmitPlaintext
	if err := c.openOutbound(cmd, cmd.UserID, cmd.LoginSessionID+"/"+cmd.StepID, &plain); err != nil {
		return err
	}
	s.lock.Lock()
	step, stepID := s.step, s.stepID
	s.lock.Unlock()
	if step == nil || stepID != cmd.StepID {
		return conflict("that login step isn't the current one")
	}
	go func() {
		var next *bridgev2.LoginStep
		var err error
		switch step.Type {
		case bridgev2.LoginStepTypeUserInput:
			proc, ok := s.process.(bridgev2.LoginProcessUserInput)
			if !ok {
				err = errors.New("login process doesn't accept input")
				break
			}
			next, err = proc.SubmitUserInput(s.ctx, plain.Input)
		case bridgev2.LoginStepTypeCookies:
			proc, ok := s.process.(bridgev2.LoginProcessCookies)
			if !ok {
				err = errors.New("login process doesn't accept cookies")
				break
			}
			next, err = proc.SubmitCookies(s.ctx, plain.Input)
		default:
			err = errors.New("the current login step doesn't take input")
		}
		// The input is a credential; drop the only copy as soon as it's used.
		clear(plain.Input)
		s.advance(next, err)
	}()
	return nil
}

func (c *Connector) handleLoginCancel(ctx context.Context, cmd *protocol.Command) error {
	raw, ok := c.logins.LoadAndDelete(cmd.LoginSessionID)
	if !ok {
		return nil
	}
	s := raw.(*loginSession)
	if s.userID != cmd.UserID {
		c.logins.Store(s.id, s)
		return conflict("login session belongs to someone else")
	}
	s.finish()
	return s.emit(&protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepCancelled})
}

func (s *loginSession) finish() {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.done {
		return
	}
	s.done = true
	s.cancel()
	s.process.Cancel()
}

func (s *loginSession) emit(step *protocol.LoginStep) error {
	return s.c.emit(s.c.Bridge.BackgroundCtx, &protocol.Event{
		Type: protocol.EventLoginStep, UserID: s.userID, LoginID: step.LoginID, LoginSessionID: s.id, Step: step,
	})
}

// advance records the step the network returned and reports it. A display-and-wait step
// keeps waiting in the background until the network moves on.
func (s *loginSession) advance(step *bridgev2.LoginStep, err error) {
	log := s.c.Log.With().Str("login_session_id", s.id).Logger()
	s.lock.Lock()
	if s.done {
		s.lock.Unlock()
		return
	}
	s.lock.Unlock()
	if err == nil && step == nil {
		err = errors.New("login process returned no step")
	}
	if err != nil {
		s.c.logins.Delete(s.id)
		s.finish()
		if emitErr := s.emit(&protocol.LoginStep{StepID: randomStepID(), Type: protocol.StepError, Error: err.Error()}); emitErr != nil {
			log.Err(emitErr).Msg("Failed to report login error")
		}
		return
	}
	stepID := step.TxnID
	if stepID == "" {
		stepID = randomStepID()
	}
	s.lock.Lock()
	s.step, s.stepID = step, stepID
	s.lock.Unlock()
	out := &protocol.LoginStep{StepID: stepID, Instructions: step.Instructions}
	switch step.Type {
	case bridgev2.LoginStepTypeDisplayAndWait:
		out.Type = protocol.StepDisplayAndWait
		if p := step.DisplayAndWaitParams; p != nil {
			out.Display = &protocol.LoginDisplay{Type: string(p.Type), Data: p.Data}
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
			out.Cookies = &protocol.LoginCookies{URL: p.URL, UserAgent: p.UserAgent}
			for _, f := range p.Fields {
				out.Cookies.Fields = append(out.Cookies.Fields, protocol.LoginCookieField{ID: f.ID, Required: f.Required})
			}
		}
	case bridgev2.LoginStepTypeComplete:
		out.Type = protocol.StepComplete
		if p := step.CompleteParams; p != nil {
			loginID, err := s.c.loginOpaque(s.c.Bridge.BackgroundCtx, p.UserLoginID)
			if err != nil {
				log.Err(err).Msg("Failed to record login ID")
			}
			out.LoginID = loginID
		}
		s.c.logins.Delete(s.id)
		s.lock.Lock()
		s.done = true
		s.lock.Unlock()
		s.cancel()
	default:
		s.advance(nil, errors.New("this login step type isn't supported: "+string(step.Type)))
		return
	}
	if err := s.emit(out); err != nil {
		log.Err(err).Msg("Failed to report login step")
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

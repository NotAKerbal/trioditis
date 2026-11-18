package connector

import (
	"context"
	"errors"
	"time"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// Commands are stored, payload included, before the gateway is told 202, and a worker runs
// them from the store in the order they arrived. A command acknowledged is therefore never
// lost to a crash: either it runs after the restart, or (if it may already have reached the
// network) it is settled as unknown. See docs/architecture/bridge-protocol.md, Commands.
//
// Commands for one chat run one at a time: the next waits until a send in that chat has an
// outcome (or is marked unknown). So a send's deadline is checked when it is really about to
// be handed to bridgev2, not when it was queued behind others.

// Submit checks a command, stores it and wakes the worker. It returns nil once the command
// is stored (or was stored before, for a repeated command ID); the caller then answers 202.
func (c *Connector) Submit(ctx context.Context, cmd *protocol.Command) error {
	// A command ID seen before is acknowledged as it is: checking it again could refuse a
	// command that has already run (its login step has moved on, say).
	if seen, err := c.Store.HasCommand(ctx, cmd.CommandID); err != nil || seen {
		return err
	}
	if err := c.Prepare(ctx, cmd); err != nil {
		return err
	}
	if _, err := c.Store.EnqueueCommand(ctx, cmd); err != nil {
		return err
	}
	c.wakeWorker()
	return nil
}

func (c *Connector) wakeWorker() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// workerIdle is how often the worker looks again with nothing to wake it.
const workerIdle = 5 * time.Second

// RunWorker runs stored commands until ctx is cancelled.
func (c *Connector) RunWorker(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		case <-timer.C:
		}
		c.runQueued(ctx)
		timer.Reset(workerIdle)
	}
}

func (c *Connector) runQueued(ctx context.Context) {
	queued, err := c.Store.QueuedCommands(ctx)
	if err != nil {
		c.Log.Err(err).Msg("Failed to read the command queue")
		return
	}
	for _, qc := range queued {
		if ctx.Err() != nil {
			return
		}
		cmd := qc.Command
		// A chat with a send in flight holds every later command for it, in order.
		if cmd.PortalID != "" {
			if _, busy := c.busy.Load(cmd.PortalID); busy {
				continue
			}
		}
		c.runOne(ctx, cmd)
	}
}

func (c *Connector) runOne(ctx context.Context, cmd *protocol.Command) {
	log := c.Log.With().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).Logger()
	if err := c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandStarted); err != nil {
		log.Err(err).Msg("Failed to start command")
		return
	}
	err := c.HandleCommand(ctx, cmd)
	if err != nil {
		code := protocol.ErrInternal
		var cmdErr *CommandError
		refused := errors.As(err, &cmdErr)
		if refused {
			code = cmdErr.Code
			log.Debug().Str("code", code).Msg("Command refused when it ran")
		} else {
			log.Err(err).Msg("Command failed")
		}
		c.reportUnrun(ctx, cmd, code, refused)
	}
	if err = c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandDone); err != nil {
		log.Err(err).Msg("Failed to finish command")
	}
}

// reportUnrun tells the person a command they were promised (202) didn't run: a send
// fails, a login ends with an error. Other commands have no outcome to report.
//
// Login input refused when it runs is a step that has moved on, or a second submit of the
// same step: the login itself carries on.
func (c *Connector) reportUnrun(ctx context.Context, cmd *protocol.Command, code string, refused bool) {
	switch cmd.Type {
	case protocol.CommandSend, protocol.CommandEdit:
		if _, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); err == nil {
			return // it got as far as being recorded; its own status stands
		}
		o := &owner{userID: cmd.UserID, loginID: cmd.LoginID}
		out := &store.Outgoing{UserID: cmd.UserID, LoginID: cmd.LoginID, ClientMessageID: cmd.ClientMessageID, Status: protocol.StatusFailed, Error: code}
		if err := c.recordSend(ctx, o, out, true); err != nil && !errors.Is(err, errAlreadyRecorded) {
			c.Log.Err(err).Msg("Failed to report a send that didn't run")
		}
	case protocol.CommandLoginStart:
		c.endLoginWithError(cmd.UserID, cmd.LoginSessionID, protocol.ErrLoginFailed)
	case protocol.CommandLoginSubmit:
		if !refused {
			c.endLoginWithError(cmd.UserID, cmd.LoginSessionID, protocol.ErrLoginFailed)
		}
	}
}

// RecoverCommands runs at startup, before the worker, for commands the last process was
// running when it stopped. A send that was recorded may have reached the network, so its
// status (unknown, from MarkInFlightUnknown) stands; one that wasn't recorded never reached
// bridgev2 and runs again. Logins don't survive a restart, so their commands end the login.
// Anything else may or may not have happened and isn't run twice.
func (c *Connector) RecoverCommands(ctx context.Context) error {
	started, err := c.Store.StartedCommands(ctx)
	if err != nil {
		return err
	}
	for _, qc := range started {
		cmd := qc.Command
		state := store.CommandDone
		switch cmd.Type {
		case protocol.CommandSend, protocol.CommandEdit:
			if _, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); errors.Is(err, store.ErrNotFound) {
				state = store.CommandQueued
			} else if err != nil {
				return err
			}
		case protocol.CommandLoginStart, protocol.CommandLoginSubmit:
			c.endLoginWithError(cmd.UserID, cmd.LoginSessionID, protocol.ErrInternal)
		default:
			c.Log.Warn().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).
				Msg("A command was interrupted by a restart and isn't run again")
		}
		if err = c.Store.SetCommandState(ctx, cmd.CommandID, state); err != nil {
			return err
		}
	}
	return nil
}

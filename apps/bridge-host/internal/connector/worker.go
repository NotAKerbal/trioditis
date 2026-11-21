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
// Each chat has its own lane: its commands run one at a time, in order, on their own
// goroutine, and a send holds the lane until it has an outcome (or is marked unknown). A chat
// stuck inside bridgev2 or the network holds up only itself, never the worker or other
// chats. Commands without a chat (logins, logout) run on the worker itself; they only start
// work and return.

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

// laneShutdownWait is how long stopping waits for chats' commands to finish. A command
// stuck inside a network connector isn't waited for longer: it is left as started, and the
// next start settles it.
const laneShutdownWait = 10 * time.Second

// RunWorker runs stored commands until ctx is cancelled.
func (c *Connector) RunWorker(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	defer c.waitForLanes()
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

func (c *Connector) waitForLanes() {
	done := make(chan struct{})
	go func() {
		c.lanesRunning.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(laneShutdownWait):
		c.Log.Warn().Msg("A chat's command is still running at shutdown; it is settled at the next start")
	}
}

func (c *Connector) runQueued(ctx context.Context) {
	queued, err := c.Store.QueuedCommands(ctx)
	if err != nil {
		c.Log.Err(err).Msg("Failed to read the command queue")
		return
	}
	for _, cmd := range candidates(queued) {
		if ctx.Err() != nil {
			return
		}
		if cmd.PortalID == "" {
			c.runOne(ctx, cmd)
			continue
		}
		// A chat whose lane is running a command, or that has a send waiting for its outcome,
		// holds its earliest command, and so every later one.
		if _, busy := c.busy.Load(cmd.PortalID); busy {
			continue
		}
		if _, running := c.lanes.LoadOrStore(cmd.PortalID, struct{}{}); running {
			continue
		}
		// Started before the lane goroutine runs, so the next pass doesn't pick it up again.
		if err = c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandStarted); err != nil {
			c.lanes.Delete(cmd.PortalID)
			c.Log.Err(err).Str("command_id", cmd.CommandID).Msg("Failed to start command")
			continue
		}
		c.lanesRunning.Add(1)
		go func() {
			defer c.lanesRunning.Done()
			defer c.wakeWorker()
			defer c.lanes.Delete(cmd.PortalID)
			c.execute(ctx, cmd)
		}()
	}
}

// candidates is what one pass may start, in queue order: every command without a chat, and
// only the earliest waiting command of each chat. A chat's later commands are never
// candidates while an earlier one waits, so they can't overtake it even if the chat's lane
// frees up part-way through a pass.
func candidates(queued []*store.QueuedCommand) []*protocol.Command {
	seen := map[string]bool{}
	var out []*protocol.Command
	for _, qc := range queued {
		cmd := qc.Command
		if cmd.PortalID != "" {
			if seen[cmd.PortalID] {
				continue
			}
			seen[cmd.PortalID] = true
		}
		out = append(out, cmd)
	}
	return out
}

func (c *Connector) runOne(ctx context.Context, cmd *protocol.Command) {
	if err := c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandStarted); err != nil {
		c.Log.Err(err).Str("command_id", cmd.CommandID).Msg("Failed to start command")
		return
	}
	c.execute(ctx, cmd)
}

// execute runs a started command and finishes it. A command that fails is reported (a send
// fails, a login ends) before it is finished, and finishing deletes its payload; if the
// report can't be written, the command stays started, payload and all, for the next start.
func (c *Connector) execute(ctx context.Context, cmd *protocol.Command) {
	log := c.Log.With().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).Logger()
	if err := c.HandleCommand(ctx, cmd); err != nil {
		code := protocol.ErrInternal
		var cmdErr *CommandError
		refused := errors.As(err, &cmdErr)
		if refused {
			code = cmdErr.Code
			log.Debug().Str("code", code).Msg("Command refused when it ran")
		} else {
			log.Warn().Str("error_type", errorType(err)).Msg("Command failed")
		}
		if err = retry(ctx, func() error { return c.reportUnrun(ctx, cmd, code, refused) }); err != nil {
			log.Err(err).Msg("Failed to report a command that didn't run; it is settled at the next start")
			return
		}
	}
	if err := retry(ctx, func() error { return c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandDone) }); err != nil {
		log.Err(err).Msg("Failed to finish command")
	}
}

// retry runs fn until it succeeds, with backoff, a few times or until ctx ends.
func retry(ctx context.Context, fn func() error) error {
	delay := 200 * time.Millisecond
	var err error
	for attempt := 0; attempt < 6; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
		delay *= 2
	}
	return err
}

// reportUnrun tells the person a command they were promised (202) didn't run: a send
// fails, a login ends with an error. Other commands have no outcome to report.
//
// Login input refused when it runs is a step that has moved on, or a second submit of the
// same step: the login itself carries on. A login that no longer exists has already been
// ended by the refusal.
func (c *Connector) reportUnrun(ctx context.Context, cmd *protocol.Command, code string, refused bool) error {
	switch cmd.Type {
	case protocol.CommandSend, protocol.CommandEdit:
		if _, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); err == nil {
			return nil // it got as far as being recorded; its own status stands
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		o := &owner{userID: cmd.UserID, loginID: cmd.LoginID}
		out := &store.Outgoing{UserID: cmd.UserID, LoginID: cmd.LoginID, ClientMessageID: cmd.ClientMessageID, Status: protocol.StatusFailed, Error: code}
		if err := c.recordSend(ctx, o, out, true); err != nil && !errors.Is(err, errAlreadyRecorded) {
			return err
		}
	case protocol.CommandLoginStart:
		return c.endLoginWithError(ctx, cmd.UserID, cmd.LoginSessionID, protocol.ErrLoginFailed)
	case protocol.CommandLoginSubmit:
		if !refused {
			return c.endLoginWithError(ctx, cmd.UserID, cmd.LoginSessionID, protocol.ErrLoginFailed)
		}
	case protocol.CommandStartChat:
		// Accepted, then couldn't run (its login went away, say): say so, rather than leave
		// the request waiting for its deadline.
		// Prepare's refusals came before it was accepted, so every refusal here is after.
		if requestIDPattern.MatchString(cmd.RequestID) {
			return c.emit(ctx, &protocol.Event{
				Type: protocol.EventChatStarted, UserID: cmd.UserID, LoginID: cmd.LoginID, RequestID: cmd.RequestID, Error: code,
			})
		}
	}
	return nil
}

// RecoverCommands runs at startup, before the worker, for commands the last process was
// running when it stopped. A send that was recorded may have reached the network, so its
// status (unknown, from MarkInFlightUnknown) stands; one that wasn't recorded never reached
// bridgev2 and runs again. Logins don't survive a restart: every login that was in progress
// (RecoverLogins) ends with an error. Anything else may or may not have happened and isn't
// run twice.
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
			if err = c.endLoginWithError(ctx, cmd.UserID, cmd.LoginSessionID, protocol.ErrInternal); err != nil {
				return err
			}
		default:
			c.Log.Warn().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).
				Msg("A command was interrupted by a restart and isn't run again")
		}
		if err = c.Store.SetCommandState(ctx, cmd.CommandID, state); err != nil {
			return err
		}
	}
	return c.RecoverLogins(ctx)
}

// SettleRestored runs at startup in place of resuming the queue, once, when the host's data was
// just restored from a backup (deploy/trioditis restore; docs/deploy.md, Restore). The server ran
// on after the backup was taken, so a send the restored queue holds, queued or started, may
// already have gone out from the original: none runs. Each that wasn't recorded is recorded as
// unknown, which reaches the backend through the journal like any send status, and the person
// decides; one recorded already keeps its status (MarkInFlightUnknown settles one that was in
// flight). Logins in progress end with an error; anything else isn't run, and says so.
func (c *Connector) SettleRestored(ctx context.Context) error {
	for _, list := range []func(context.Context) ([]*store.QueuedCommand, error){c.Store.StartedCommands, c.Store.QueuedCommands} {
		commands, err := list(ctx)
		if err != nil {
			return err
		}
		for _, qc := range commands {
			cmd := qc.Command
			switch cmd.Type {
			case protocol.CommandSend, protocol.CommandEdit:
				if _, err := c.Store.GetOutgoing(ctx, cmd.UserID, cmd.ClientMessageID); errors.Is(err, store.ErrNotFound) {
					o := &owner{userID: cmd.UserID, loginID: cmd.LoginID}
					out := &store.Outgoing{UserID: cmd.UserID, LoginID: cmd.LoginID, ClientMessageID: cmd.ClientMessageID, Status: protocol.StatusUnknown}
					if err := c.recordSend(ctx, o, out, true); err != nil && !errors.Is(err, errAlreadyRecorded) {
						return err
					}
				} else if err != nil {
					return err
				}
			case protocol.CommandLoginStart, protocol.CommandLoginSubmit:
				if err := c.endLoginWithError(ctx, cmd.UserID, cmd.LoginSessionID, protocol.ErrInternal); err != nil {
					return err
				}
			default:
				c.Log.Warn().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).
					Msg("A command restored from a backup isn't run: it may have run already")
			}
			if err := c.Store.SetCommandState(ctx, cmd.CommandID, store.CommandDone); err != nil {
				return err
			}
		}
	}
	return nil
}

// RecoverLogins ends every login that was in progress when the process stopped: the
// network's login flow lived in memory and is gone, so the person is told and can start
// again, instead of waiting on a QR code nobody will ever answer.
func (c *Connector) RecoverLogins(ctx context.Context) error {
	sessions, err := c.Store.LoginSessions(ctx)
	if err != nil {
		return err
	}
	for _, ls := range sessions {
		if err = c.endLoginWithError(ctx, ls.UserID, ls.ID, protocol.ErrInternal); err != nil {
			return err
		}
	}
	return nil
}

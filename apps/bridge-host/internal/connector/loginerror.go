package connector

import (
	"fmt"

	"github.com/rs/zerolog"
)

// LoginErrorDescriber is implemented by a network connector that can say more about why a
// login failed than the shape of its error, from the codes its library keeps on the error.
// It adds fields to the log line and never the error's text, which can quote what the person
// typed or what the network sent back. It looks at the error only through WalkErrors, which
// is bounded, and any panic in it is recovered.
type LoginErrorDescriber interface {
	DescribeLoginError(evt *zerolog.Event, err error)
}

// maxErrorChain is how many of an error's wrapped errors a log line lists.
const maxErrorChain = 12

// maxErrorVisits is how many errors WalkErrors visits in all, however the errors nest: enough
// for any real chain, and a stop for a cyclic one.
const maxErrorVisits = 64

// describeLoginError adds to a failed login's log line what can be said about its error
// without its text: the type of every error it wraps, in order, and whatever the network
// connector adds (LoginErrorDescriber). The outer type alone (often *fmt.wrapErrors) doesn't
// tell which step of a login failed. Error codes aren't logged here: a mautrix error's code
// can come from what a server sent, so only a network's own table of codes names them.
//
// A panic while looking at an odd error is recovered and noted on the line.
func (c *Connector) describeLoginError(evt *zerolog.Event, err error) *zerolog.Event {
	evt = evt.Str("error_type", fmt.Sprintf("%T", err))
	if !describeSafely(evt, func() { describeChain(evt, err) }) {
		return evt
	}
	if c.Bridge != nil {
		if d, ok := c.Bridge.Network.(LoginErrorDescriber); ok {
			describeSafely(evt, func() { d.DescribeLoginError(evt, err) })
		}
	}
	return evt
}

// describeSafely runs describe, and marks the line if it panicked.
func describeSafely(evt *zerolog.Event, describe func()) (ok bool) {
	defer func() {
		if recover() != nil {
			evt.Bool("error_describe_failed", true)
			ok = false
		}
	}()
	describe()
	return true
}

func describeChain(evt *zerolog.Event, err error) {
	var types []string
	WalkErrors(err, func(e error) {
		if len(types) < maxErrorChain {
			types = append(types, fmt.Sprintf("%T", e))
		}
	})
	evt.Strs("error_chain", types)
}

// WalkErrors calls fn with err and every error it wraps, depth first, in the order errors.Is
// would look at them, visiting at most maxErrorVisits errors in all, so a cyclic chain ends.
func WalkErrors(err error, fn func(error)) {
	budget := maxErrorVisits
	walkErrorsFrom(err, fn, &budget)
}

func walkErrorsFrom(err error, fn func(error), budget *int) {
	for err != nil && *budget > 0 {
		*budget--
		fn(err)
		inner, many := unwrap(err)
		if many {
			for _, e := range inner {
				walkErrorsFrom(e, fn, budget)
			}
			return
		}
		if len(inner) == 0 {
			return
		}
		err = inner[0]
	}
}

// unwrap is what err wraps, and whether it can wrap several. An Unwrap that panics, as a value
// method on a nil pointer does, wraps nothing.
func unwrap(err error) (inner []error, many bool) {
	defer func() {
		if recover() != nil {
			inner = nil
		}
	}()
	switch u := err.(type) {
	case interface{ Unwrap() []error }:
		return u.Unwrap(), true
	case interface{ Unwrap() error }:
		if e := u.Unwrap(); e != nil {
			return []error{e}, false
		}
	}
	return nil, false
}

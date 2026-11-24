package connector

import (
	"fmt"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
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
// without its text: the type of every error it wraps, in order, the codes of the mautrix
// errors among them, and whatever the network connector adds (LoginErrorDescriber). The
// outer type alone (often *fmt.wrapErrors) doesn't tell which step of a login failed.
//
// The login's failure is reported to the person after this, so nothing here may stop that: a
// panic while looking at an odd error is recovered and noted on the line.
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
	var types, codes []string
	WalkErrors(err, func(e error) {
		if len(types) < maxErrorChain {
			types = append(types, fmt.Sprintf("%T", e))
		}
		if code := RespErrorCode(e); code != "" {
			codes = append(codes, code)
		}
	})
	evt.Strs("error_chain", types)
	if len(codes) > 0 {
		evt.Strs("error_codes", codes)
	}
}

// RespErrorCode is the code of a mautrix error, such as M_UNKNOWN or a connector's own
// FI.MAU.GMESSAGES.PAIR_NO_DEVICES: a constant the code defines, unlike the message beside it.
// Empty for any other error.
func RespErrorCode(e error) string {
	switch re := e.(type) {
	case bridgev2.RespError:
		return re.ErrCode
	case *bridgev2.RespError:
		if re != nil {
			return re.ErrCode
		}
	case mautrix.RespError:
		return re.ErrCode
	case *mautrix.RespError:
		if re != nil {
			return re.ErrCode
		}
	}
	return ""
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

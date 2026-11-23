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
// typed or what the network sent back.
type LoginErrorDescriber interface {
	DescribeLoginError(evt *zerolog.Event, err error)
}

// maxErrorChain is how many of an error's wrapped errors a log line lists.
const maxErrorChain = 12

// describeLoginError adds to a failed login's log line what can be said about its error
// without its text: the type of every error it wraps, in order, the codes of the mautrix
// errors among them, and whatever the network connector adds (LoginErrorDescriber). The
// outer type alone (often *fmt.wrapErrors) doesn't tell which step of a login failed.
func (c *Connector) describeLoginError(evt *zerolog.Event, err error) *zerolog.Event {
	var types, codes []string
	WalkErrors(err, func(e error) {
		if len(types) < maxErrorChain {
			types = append(types, fmt.Sprintf("%T", e))
		}
		// The codes are constants the connectors define, such as
		// FI.MAU.GMESSAGES.PAIR_START_UNKNOWN; the message beside them is left out.
		switch re := e.(type) {
		case bridgev2.RespError:
			codes = append(codes, re.ErrCode)
		case *bridgev2.RespError:
			codes = append(codes, re.ErrCode)
		case mautrix.RespError:
			codes = append(codes, re.ErrCode)
		case *mautrix.RespError:
			codes = append(codes, re.ErrCode)
		}
	})
	evt = evt.Str("error_type", fmt.Sprintf("%T", err)).Strs("error_chain", types)
	if len(codes) > 0 {
		evt = evt.Strs("error_codes", codes)
	}
	if c.Bridge != nil {
		if d, ok := c.Bridge.Network.(LoginErrorDescriber); ok {
			d.DescribeLoginError(evt, err)
		}
	}
	return evt
}

// WalkErrors calls fn with err and every error it wraps, depth first, in the order errors.Is
// would look at them. A chain deeper than any real one is cut short.
func WalkErrors(err error, fn func(error)) {
	walkErrorsFrom(err, fn, 0)
}

func walkErrorsFrom(err error, fn func(error), depth int) {
	for ; err != nil && depth < 32; depth++ {
		fn(err)
		switch u := err.(type) {
		case interface{ Unwrap() []error }:
			for _, inner := range u.Unwrap() {
				walkErrorsFrom(inner, fn, depth+1)
			}
			return
		case interface{ Unwrap() error }:
			err = u.Unwrap()
		default:
			return
		}
	}
}

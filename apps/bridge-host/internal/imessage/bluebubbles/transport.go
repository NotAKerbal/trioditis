package bluebubbles

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"os"
)

// TransportError is a request or socket that failed before the server answered it, or whose
// answer couldn't be read. It says what happened in fixed words only: the errors it stands for
// can carry the request's address (with the password in it) or quote what came back, which
// may be anything, a person's words included.
type TransportError struct {
	kind string
	// notSent is set when the connection never opened, so nothing of the request went.
	notSent bool
	refused bool
}

func (e *TransportError) Error() string { return "bluebubbles: " + e.kind }

// Unwrap lets errors.Is find an address the dialler refused.
func (e *TransportError) Unwrap() error {
	if e.refused {
		return ErrAddressRefused
	}
	return nil
}

// NotSent says the connection never opened: nothing of the request reached the server.
func (e *TransportError) NotSent() bool { return e.notSent }

// transport is err as a TransportError, what kind it is decided from its type alone.
func transport(err error) error {
	if err == nil {
		return nil
	}
	var op *net.OpError
	dial := errors.As(err, &op) && op.Op == "dial"
	switch {
	case errors.Is(err, ErrAddressRefused):
		return &TransportError{kind: "the address is one a Mac may not be at", notSent: true, refused: true}
	case certificateRefused(err):
		// The certificate is checked in the handshake, before any of the request is written.
		return &TransportError{kind: "the server's certificate was refused", notSent: true}
	case dial:
		return &TransportError{kind: "couldn't connect", notSent: true}
	case errors.Is(err, context.Canceled):
		return &TransportError{kind: "cancelled"}
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded):
		return &TransportError{kind: "timed out"}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &TransportError{kind: "timed out"}
	}
	return &TransportError{kind: "the connection failed"}
}

// certificateRefused says the server's certificate failed verification.
func certificateRefused(err error) bool {
	var verify *tls.CertificateVerificationError
	var unknown x509.UnknownAuthorityError
	var host x509.HostnameError
	var invalid x509.CertificateInvalidError
	return errors.As(err, &verify) || errors.As(err, &unknown) || errors.As(err, &host) || errors.As(err, &invalid)
}

// errUnreadable is an answer that came but couldn't be read as the server writes it.
var errUnreadable = &TransportError{kind: "couldn't read the answer"}

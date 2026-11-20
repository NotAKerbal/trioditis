// Package server is the bridge host's internal API: its command endpoint, POST /v1/commands,
// the sign-in browser's viewer, GET /v1/logins/{id}/browser, and encrypted media,
// GET /v1/media/{id}.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"os"
	"strconv"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/connector"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
)

// Handler checks and stores commands for running.
type Handler interface {
	// Submit refuses an invalid command with a *connector.CommandError, and otherwise
	// returns once the command is stored durably, payload included.
	Submit(ctx context.Context, cmd *protocol.Command) error
}

// Browsers finds the sign-in browser for a login's current cookie step.
type Browsers interface {
	// OpenBrowser refuses a login or step that isn't current with a *connector.CommandError.
	OpenBrowser(ctx context.Context, loginSessionID, userID, stepID string) (*signin.Browser, error)
}

// Media opens a person's encrypted files (media.Store).
type Media interface {
	Open(mediaID, ownerUserID string) (*os.File, error)
}

// Server serves the internal command API.
type Server struct {
	Token    string
	Handler  Handler
	Browsers Browsers
	Media    Media
	// Refuse, if set, turns away connections from an address that must not use the API at
	// all: the sign-in browser's (signin.FromBrowser).
	Refuse func(netip.Addr) bool
	Log    zerolog.Logger
}

const maxBody = 1 << 20

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/commands", s.handleCommand)
	mux.HandleFunc("GET /v1/logins/{id}/browser", s.handleBrowser)
	mux.HandleFunc("GET /v1/media/{id}", s.handleMedia)
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	if s.Refuse == nil {
		return mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if remote, err := netip.ParseAddrPort(r.RemoteAddr); err != nil || s.Refuse(remote.Addr()) {
			writeError(w, http.StatusForbidden, protocol.ErrInvalidCommand)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// writeError answers with a protocol error code, never free text.
func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

func (s *Server) authorized(r *http.Request) bool {
	want := "Bearer " + s.Token
	got := r.Header.Get("Authorization")
	return s.Token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, protocol.ErrInvalidCommand)
		return
	}
	var cmd protocol.Command
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&cmd); err != nil {
		writeError(w, http.StatusBadRequest, protocol.ErrInvalidCommand)
		return
	} else if cmd.CommandID == "" || cmd.Type == "" {
		writeError(w, http.StatusBadRequest, protocol.ErrInvalidCommand)
		return
	}
	ctx := s.Log.With().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).Logger().WithContext(r.Context())
	// 202 means the command is stored, payload included, and will run (or, for a command
	// ID seen before, already is stored). A command refused here isn't stored, so it may be
	// sent again once the problem is fixed.
	if err := s.Handler.Submit(ctx, &cmd); err != nil {
		var cmdErr *connector.CommandError
		if errors.As(err, &cmdErr) {
			s.Log.Debug().Str("code", cmdErr.Code).Str("detail", cmdErr.Detail).Msg("Command refused")
			writeError(w, cmdErr.Status, cmdErr.Code)
			return
		}
		s.Log.Err(err).Msg("Command failed")
		writeError(w, http.StatusInternalServerError, protocol.ErrInternal)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// handleBrowser connects a viewer, relayed by the gateway once it has redeemed the person's
// ticket, to the sign-in browser of their login's current step
// (docs/architecture/signin-browser.md, Tickets).
func (s *Server) handleBrowser(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, protocol.ErrInvalidCommand)
		return
	} else if s.Browsers == nil {
		writeError(w, http.StatusConflict, protocol.ErrUnsupported)
		return
	}
	userID, stepID := r.Header.Get("X-Trioditis-User-Id"), r.Header.Get("X-Trioditis-Step-Id")
	if userID == "" || stepID == "" {
		writeError(w, http.StatusBadRequest, protocol.ErrInvalidCommand)
		return
	}
	browser, err := s.Browsers.OpenBrowser(r.Context(), r.PathValue("id"), userID, stepID)
	if err != nil {
		var cmdErr *connector.CommandError
		if errors.As(err, &cmdErr) {
			writeError(w, cmdErr.Status, cmdErr.Code)
			return
		}
		writeError(w, http.StatusInternalServerError, protocol.ErrInternal)
		return
	}
	// The gateway checked the origin's ticket; what reaches here comes from it.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	_ = browser.Watch(r.Context(), ws)
}

// handleMedia sends the ciphertext of one of a person's files, for the gateway to pass to their
// client, which has its key (docs/architecture/bridge-protocol.md, Media). The gateway names
// the person once it has checked their access token.
func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, protocol.ErrInvalidCommand)
		return
	} else if s.Media == nil {
		writeError(w, http.StatusConflict, protocol.ErrUnsupported)
		return
	}
	userID := r.Header.Get("X-Trioditis-User-Id")
	if userID == "" {
		writeError(w, http.StatusBadRequest, protocol.ErrInvalidCommand)
		return
	}
	f, err := s.Media.Open(r.PathValue("id"), userID)
	if err != nil {
		// No code: the gateway only needs to know this host doesn't have it for them.
		w.WriteHeader(http.StatusNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, protocol.ErrInternal)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

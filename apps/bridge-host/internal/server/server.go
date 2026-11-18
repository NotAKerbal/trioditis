// Package server is the bridge host's command endpoint, POST /v1/commands.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/rs/zerolog"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/connector"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
)

// Handler checks and stores commands for running.
type Handler interface {
	// Submit refuses an invalid command with a *connector.CommandError, and otherwise
	// returns once the command is stored durably, payload included.
	Submit(ctx context.Context, cmd *protocol.Command) error
}

// Server serves the internal command API.
type Server struct {
	Token   string
	Handler Handler
	Log     zerolog.Logger
}

const maxBody = 1 << 20

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/commands", s.handleCommand)
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
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

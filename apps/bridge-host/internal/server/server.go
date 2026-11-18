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
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// Handler runs commands.
type Handler interface {
	HandleCommand(ctx context.Context, cmd *protocol.Command) error
}

// Server serves the internal command API.
type Server struct {
	Token   string
	Store   *store.Store
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

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (s *Server) authorized(r *http.Request) bool {
	want := "Bearer " + s.Token
	got := r.Header.Get("Authorization")
	return s.Token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var cmd protocol.Command
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&cmd); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	} else if cmd.CommandID == "" || cmd.Type == "" {
		writeError(w, http.StatusBadRequest, "commandId and type are required")
		return
	}
	ctx := s.Log.With().Str("command_id", cmd.CommandID).Str("command_type", cmd.Type).Logger().WithContext(r.Context())
	isNew, err := s.Store.ClaimCommand(ctx, cmd.CommandID)
	if err != nil {
		s.Log.Err(err).Msg("Failed to record command")
		writeError(w, http.StatusInternalServerError, "failed to record command")
		return
	} else if !isNew {
		// Already run. The gateway is retrying a command whose 202 it missed.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if err = s.Handler.HandleCommand(ctx, &cmd); err != nil {
		// A command refused before it ran may be sent again once the problem is fixed.
		if releaseErr := s.Store.ReleaseCommand(ctx, cmd.CommandID); releaseErr != nil {
			s.Log.Err(releaseErr).Msg("Failed to release refused command")
		}
		var cmdErr *connector.CommandError
		if errors.As(err, &cmdErr) {
			writeError(w, cmdErr.Status, cmdErr.Message)
			return
		}
		s.Log.Err(err).Msg("Command failed")
		writeError(w, http.StatusInternalServerError, "command failed")
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

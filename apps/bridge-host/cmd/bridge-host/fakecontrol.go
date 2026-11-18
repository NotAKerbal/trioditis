package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/pkg/fakenet"
)

// serveFakeControl lets a dev-stack test drive the fake network from outside the process:
// POST /fake/incoming delivers a message as if someone sent it on the network. It only
// exists for --network fake with BRIDGE_FAKE_CONTROL_ADDR set, only on loopback, behind the
// internal token.
func serveFakeControl(ctx context.Context, addr, token string, fake *fakenet.Network, log zerolog.Logger) {
	host, _, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		log.Error().Str("addr", addr).Msg("Fake network control only listens on a loopback IP address; not starting it")
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fake/incoming", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			LoginID   string `json:"loginId"`
			ChatID    string `json:"chatId"`
			SenderID  string `json:"senderId"`
			MessageID string `json:"messageId"`
			Text      string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil || body.LoginID == "" || body.ChatID == "" || body.MessageID == "" {
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		err := fake.Incoming(networkid.UserLoginID(body.LoginID), networkid.PortalID(body.ChatID), networkid.UserID(body.SenderID),
			networkid.MessageID(body.MessageID), body.Text, time.Now())
		if err != nil {
			log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Fake incoming message failed")
			http.Error(w, "failed", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	})
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	log.Warn().Str("addr", addr).Msg("Fake network control is on. Dev only.")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error().Err(err).Msg("Fake network control stopped")
	}
}

//go:build libsignal

package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// The process logger goes through the network's filter: for Signal, the field
// signalmeow puts the history transfer's backup key in never reaches the output, and other
// networks' output is left as it is.
func TestLogOutputFiltersOnlyNetworksThatAskForIt(t *testing.T) {
	var signalOut, whatsappOut bytes.Buffer
	signalLog := zerolog.New(logOutput("signal", &signalOut))
	signalLog.Info().Str("backup_info", "synthetic-key").Msg("Received backup info")
	whatsappLog := zerolog.New(logOutput("whatsapp", &whatsappOut))
	whatsappLog.Info().Str("backup_info", "kept").Msg("unrelated")
	if strings.Contains(signalOut.String(), "synthetic-key") {
		t.Errorf("Signal's log kept the backup info: %s", signalOut.String())
	}
	if !strings.Contains(whatsappOut.String(), "kept") {
		t.Errorf("another network's log was filtered: %s", whatsappOut.String())
	}
}

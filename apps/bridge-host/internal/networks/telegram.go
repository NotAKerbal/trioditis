package networks

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"
	telegram "go.mau.fi/mautrix-telegram/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
)

// Telegram only lets a client in with an API ID and hash, which it issues to whoever runs
// the client (https://my.telegram.org/apps). The connector's example config has
// placeholders that Telegram refuses, so the operator supplies a real pair, and the bridge
// host won't start without one. See docs/networks/telegram.md.
const (
	telegramAPIIDEnv   = "TELEGRAM_API_ID"
	telegramAPIHashEnv = "TELEGRAM_API_HASH"
)

// The connector remembers which content URI it uploaded each Telegram file to, and reuses
// it instead of downloading the file again. The bridge host's uploads only live in memory
// for media.UploadTTL, so a remembered URI would soon point at nothing, and the message
// reusing it would arrive without its file. Remembered files are forgotten at start-up and
// once they are telegramFileMaxAge old, which, swept every telegramFileSweepInterval, is
// well inside the upload's lifetime.
const (
	telegramFileMaxAge        = media.UploadTTL / 2
	telegramFileSweepInterval = media.UploadTTL / 10
)

func init() {
	register("telegram", Network{
		New: newTelegram,
		Background: func(ctx context.Context, conn bridgev2.NetworkConnector, log zerolog.Logger) func() {
			tc := conn.(*telegramConnector)
			return startTelegramFileSweep(ctx, tc, log.With().Str("component", "telegram file sweep").Logger())
		},
	})
}

// telegramConnector is mautrix-telegram's connector, with the file cache cleared when it
// starts. It embeds the connector, so bridgev2 sees every method and optional interface the
// connector has.
type telegramConnector struct {
	*telegram.TelegramConnector
}

// Start runs the connector's own start (its database upgrade), then forgets every file the
// last run uploaded: those uploads went with that process. bridgev2 starts the logins only
// after this, so no message can reuse one.
func (tc *telegramConnector) Start(ctx context.Context) error {
	if err := tc.TelegramConnector.Start(ctx); err != nil {
		return err
	}
	if _, err := tc.Store.Exec(ctx, "DELETE FROM telegram_file"); err != nil {
		return fmt.Errorf("failed to clear Telegram's file cache: %w", err)
	}
	return nil
}

func newTelegram() (bridgev2.NetworkConnector, error) {
	conn := &telegram.TelegramConnector{}
	if _, err := withDefaults("Telegram", conn); err != nil {
		return nil, err
	}
	cfg := &conn.Config
	var err error
	if cfg.APIID, cfg.APIHash, err = telegramAPICredentials(); err != nil {
		return nil, err
	}
	// Shown in the person's list of active Telegram sessions, where they'd look for it.
	cfg.DeviceInfo.DeviceModel = "Trioditis"
	// The example points the Saved Messages chat's avatar at an image on maunium.net's
	// homeserver. There is no homeserver here to fetch it from, so the chat has none.
	cfg.SavedMessagesAvatar = ""
	if err = conn.ValidateConfig(); err != nil {
		return nil, fmt.Errorf("invalid Telegram settings: %w", err)
	}
	return &telegramConnector{conn}, nil
}

// telegramAPICredentials reads the operator's API ID and hash from the environment.
func telegramAPICredentials() (int, string, error) {
	rawID := strings.TrimSpace(os.Getenv(telegramAPIIDEnv))
	hash := strings.TrimSpace(os.Getenv(telegramAPIHashEnv))
	if rawID == "" || hash == "" {
		return 0, "", fmt.Errorf("telegram needs an API ID and hash: create an app at https://my.telegram.org/apps, then set %s and %s (install.sh --telegram-api-id and --telegram-api-hash)", telegramAPIIDEnv, telegramAPIHashEnv)
	}
	id, err := strconv.Atoi(rawID)
	if err != nil || id <= 0 {
		return 0, "", fmt.Errorf("%s must be the number my.telegram.org shows as App api_id", telegramAPIIDEnv)
	}
	// An api_hash is 32 hex digits; checking catches the two values swapped or cut short,
	// which Telegram would otherwise only report at the first login.
	if _, err = hex.DecodeString(hash); err != nil || len(hash) != 32 {
		return 0, "", fmt.Errorf("%s must be the 32 hex digits my.telegram.org shows as App api_hash", telegramAPIHashEnv)
	}
	return id, hash, nil
}

// sweepTelegramFiles forgets files remembered for longer than maxAge (the table keeps Unix
// seconds), and any without a time.
func sweepTelegramFiles(ctx context.Context, tc *telegramConnector, maxAge time.Duration) error {
	cutoff := time.Now().Add(-maxAge).Unix()
	_, err := tc.Store.Exec(ctx, "DELETE FROM telegram_file WHERE timestamp IS NULL OR timestamp < $1", cutoff)
	return err
}

// startTelegramFileSweep sweeps every telegramFileSweepInterval until the returned function
// is called, which stops the sweep and waits for it.
func startTelegramFileSweep(ctx context.Context, tc *telegramConnector, log zerolog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(telegramFileSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if err := sweepTelegramFiles(ctx, tc, telegramFileMaxAge); err != nil && ctx.Err() == nil {
				log.Warn().Str("error_type", fmt.Sprintf("%T", err)).Msg("Failed to sweep Telegram's file cache")
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// Command bridge-host runs one network's bridge host. See apps/bridge-host/README.md.
//
//	bridge-host --network whatsapp run      serve the gateway (default)
//	bridge-host --network whatsapp login    log in from the terminal, for trying it out
//	bridge-host --network whatsapp inspect  print the journal, decrypted with dev keys
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/mautrix-whatsapp/pkg/connector"
	"gopkg.in/yaml.v3"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/wabuffer"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/pkg/fakenet"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	network := flag.String("network", env("BRIDGE_NETWORK", "whatsapp"), "network to bridge: whatsapp or fake")
	dataDir := flag.String("data", env("BRIDGE_DATA_DIR", ".data/bridge-host"), "data directory")
	user := flag.String("user", "", "login/inspect: the Trioditis user ID")
	flow := flag.String("flow", "", "login: login flow ID (whatsapp: qr or phone)")
	devKeys := flag.Bool("dev-keys", false, "use dev identity keys from the data directory instead of the gateway's")
	verbose := flag.Bool("verbose", false, "debug logging")
	flag.Parse()
	command := flag.Arg(0)
	if command == "" {
		command = "run"
	}

	level := zerolog.InfoLevel
	if *verbose {
		level = zerolog.DebugLevel
	}
	log := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}).Level(level).With().Timestamp().Logger()
	// Checked before anything starts, so a usage error never leaves a host running.
	switch command {
	case "run", "inspect":
	case "login":
		if *user == "" {
			log.Fatal().Msg("login needs --user")
		}
	default:
		log.Fatal().Str("command", command).Msg("Unknown command")
	}

	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal().Err(err).Msg("Failed to create data directory")
	}
	if command == "inspect" {
		if err := inspect(*network, *dataDir, *user); err != nil {
			log.Fatal().Err(err).Msg("Inspect failed")
		}
		return
	}

	bridgeKey, err := loadBridgeKey(*dataDir, log)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to load the bridge key")
	}
	netConn, err := networkConnector(*network)
	if err != nil {
		log.Fatal().Err(err).Msg("Unknown network")
	}
	cfg := host.Config{
		Network:       *network,
		HostID:        env("BRIDGE_HOST_ID", *network+"-1"),
		DataDir:       *dataDir,
		DatabaseType:  os.Getenv("BRIDGE_DATABASE_TYPE"),
		DatabaseURI:   os.Getenv("BRIDGE_DATABASE_URI"),
		ListenAddr:    env("BRIDGE_HOST_ADDR", "127.0.0.1:8611"),
		GatewayURL:    os.Getenv("GATEWAY_URL"),
		InternalToken: os.Getenv("TRIODITIS_INTERNAL_TOKEN"),
		BridgeKey:     bridgeKey,

		NetworkConnector: netConn,
		Log:              log,
	}
	cfg.CommandAddr = "http://" + cfg.ListenAddr
	keyStore := &devkeys.Keys{Dir: filepath.Join(*dataDir, "dev-keys")}
	// Dev identity keys are generated and kept on this machine, so whoever runs it could
	// read everything sealed to them. They are only ever used when asked for by name.
	if *devKeys {
		log.Warn().Msg("Using dev identity keys from the data directory. Never do this in production.")
		cfg.KeyFetcher = keyStore
	} else if cfg.GatewayURL == "" {
		log.Fatal().Msg("GATEWAY_URL is required (or --dev-keys, for trying the bridge host without a gateway)")
	}
	if command == "login" {
		// The terminal login drives the host directly; it doesn't serve commands.
		cfg.ListenAddr = ""
	}

	h, err := host.New(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to set up the bridge host")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err = h.Start(ctx); err != nil {
		log.Fatal().Err(err).Msg("Failed to start the bridge host")
	}
	// Shutdown, on every return from here: the sweeper is stopped (cancelled, then waited
	// for) before the host and its database stop.
	stopSweeping := func() {}
	defer func() {
		stopSweeping()
		h.Stop()
	}()
	if wa, ok := netConn.(*connector.WhatsAppConnector); ok {
		// Plaintext left in whatsmeow's decrypted-event buffer is deleted once it is past
		// WhatsApp's redelivery window: now, and hourly, rather than only when a message
		// arrives.
		stopSweeping = wabuffer.Start(ctx, wa.DeviceStore, wabuffer.Interval, log.With().Str("component", "whatsapp buffer").Logger())
	}
	if fake, ok := netConn.(*fakenet.Network); ok && command == "run" && os.Getenv("BRIDGE_FAKE_CONTROL_ADDR") != "" && cfg.InternalToken != "" {
		go serveFakeControl(ctx, os.Getenv("BRIDGE_FAKE_CONTROL_ADDR"), cfg.InternalToken, fake, log)
	}
	switch command {
	case "run":
		log.Info().Str("network", *network).Str("addr", h.Addr()).Msg("Bridge host running")
	case "login":
		if err = terminalLogin(ctx, h, *network, *user, *flow, bridgeKey); err != nil {
			log.Error().Err(err).Msg("Login failed")
			return
		}
		log.Info().Msg("Logged in. Messages are being bridged into the journal; run `inspect` in another terminal to read them. Ctrl+C to stop.")
	}
	<-ctx.Done()
}

func networkConnector(network string) (bridgev2.NetworkConnector, error) {
	switch network {
	case "whatsapp":
		wa := &connector.WhatsAppConnector{}
		// The connector's documented defaults, as its example config gives them.
		example, data, _ := wa.GetConfig()
		if err := yaml.Unmarshal([]byte(example), data); err != nil {
			return nil, fmt.Errorf("failed to load WhatsApp defaults: %w", err)
		}
		return wa, nil
	case "fake":
		return fakenet.New(), nil
	default:
		return nil, fmt.Errorf("%q isn't a supported network", network)
	}
}

type keyFile struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// loadBridgeKey reads the bridge key pair from the environment. In dev, if it isn't set, it
// is generated once and kept in the data directory: opaque IDs derive from it, so it must
// stay the same across restarts.
func loadBridgeKey(dataDir string, log zerolog.Logger) (seal.KeyPair, error) {
	if pub, priv := os.Getenv("BRIDGE_PUBLIC_KEY"), os.Getenv("BRIDGE_PRIVATE_KEY"); pub != "" || priv != "" {
		return seal.ParseKeyPair(pub, priv)
	}
	path := filepath.Join(dataDir, "bridge-key.json")
	if data, err := os.ReadFile(path); err == nil {
		var f keyFile
		if err = json.Unmarshal(data, &f); err != nil {
			return seal.KeyPair{}, err
		}
		return seal.ParseKeyPair(f.PublicKey, f.PrivateKey)
	} else if !errors.Is(err, os.ErrNotExist) {
		return seal.KeyPair{}, err
	}
	kp, err := seal.GenerateKeyPair()
	if err != nil {
		return kp, err
	}
	data, _ := json.Marshal(keyFile{PublicKey: kp.Public.String(), PrivateKey: seal.Encode(kp.Private[:])})
	if err = os.WriteFile(path, data, 0o600); err != nil {
		return kp, err
	}
	log.Warn().Str("public_key", kp.Public.String()).Str("file", path).Msg("Generated a dev bridge key; set BRIDGE_PUBLIC_KEY and BRIDGE_PRIVATE_KEY outside dev")
	return kp, nil
}

// terminalLogin runs a login flow through the same commands the gateway would send,
// showing each step in the terminal.
func terminalLogin(ctx context.Context, h *host.Host, network, userID, flowID string, bridgeKey seal.KeyPair) error {
	session := fmt.Sprintf("terminal-%d", time.Now().UnixNano())
	from, err := h.Store.LastSeq(ctx)
	if err != nil {
		return err
	}
	if err = h.Connector.HandleCommand(ctx, &protocol.Command{
		CommandID: session + "-start", Type: protocol.CommandLoginStart, UserID: userID,
		LoginSessionID: session, Network: network, FlowID: flowID,
	}); err != nil {
		return err
	}
	stdin := bufio.NewReader(os.Stdin)
	for {
		events, err := h.Store.After(ctx, from, 100)
		if err != nil {
			return err
		}
		for _, evt := range events {
			from = evt.Seq
			if evt.Type != protocol.EventLoginStep || evt.LoginSessionID != session {
				continue
			}
			step := evt.Step
			switch step.Type {
			case protocol.StepDisplayAndWait:
				fmt.Println(step.Instructions)
				if step.Display != nil && step.Display.Type == "qr" {
					if qr, err := qrcode.New(step.Display.Data, qrcode.Low); err == nil {
						fmt.Println(qr.ToSmallString(false))
					}
				} else if step.Display != nil && step.Display.Data != "" {
					fmt.Printf("\n    %s\n\n", step.Display.Data)
				}
			case protocol.StepUserInput, protocol.StepCookies:
				fmt.Println(step.Instructions)
				input := make(map[string]string)
				fields := step.Fields
				if step.Cookies != nil {
					for _, f := range step.Cookies.Fields {
						fields = append(fields, protocol.LoginField{ID: f.ID, Name: f.ID})
					}
				}
				for _, field := range fields {
					fmt.Printf("%s: ", field.Name)
					line, _ := stdin.ReadString('\n')
					input[field.ID] = strings.TrimSpace(line)
				}
				// Sealed to the bridge key, exactly as a client would.
				sealed, err := seal.SealJSON(protocol.LoginSubmitPlaintext{Input: input}, []seal.PublicKey{bridgeKey.Public},
					seal.Context{Kind: seal.KindOutbound, OwnerUserID: userID, ObjectID: session + "/" + step.StepID})
				if err != nil {
					return err
				}
				if err = h.Connector.HandleCommand(ctx, &protocol.Command{
					CommandID: session + "-" + step.StepID, Type: protocol.CommandLoginSubmit, UserID: userID,
					LoginSessionID: session, StepID: step.StepID, Sealed: sealed,
				}); err != nil {
					return err
				}
			case protocol.StepComplete:
				fmt.Printf("Login complete (login %s)\n", step.LoginID)
				return nil
			case protocol.StepError, protocol.StepCancelled:
				return fmt.Errorf("login ended: %s %s", step.Type, step.Error)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

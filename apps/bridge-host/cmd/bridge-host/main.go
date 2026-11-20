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
	"io"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	globallog "github.com/rs/zerolog/log"
	"github.com/skip2/go-qrcode"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/devkeys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/host"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/networks"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	// Set to fail the process once everything deferred below has run (the host stopped).
	exitCode := 0
	defer func() {
		if exitCode != 0 {
			os.Exit(exitCode)
		}
	}()
	network := flag.String("network", env("BRIDGE_NETWORK", "whatsapp"), "network to bridge: "+strings.Join(networks.Names(), ", "))
	dataDir := flag.String("data", env("BRIDGE_DATA_DIR", ".data/bridge-host"), "data directory")
	user := flag.String("user", "", "login/inspect: the Trioditis user ID")
	flow := flag.String("flow", "", "login: login flow ID (whatsapp: qr or phone; see docs/networks)")
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
	console := zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen}
	log := zerolog.New(logOutput(*network, console)).Level(level).With().Timestamp().Logger()
	// mautrix-meta's protocol decoder logs through zerolog's global logger and attaches the
	// raw protocol data, message text included, to its warnings. The global logger writes to
	// the same output but keeps only the fields known to be safe, never below warn.
	globallog.Logger = networks.GlobalLogger(console, level)
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
	spec, ok := networks.Lookup(*network)
	if !ok {
		log.Fatal().Str("network", *network).Strs("networks", networks.Names()).Msg("Unknown network")
	}
	netConn, err := spec.New()
	if err != nil {
		log.Fatal().Err(err).Str("network", *network).Msg("Failed to set up the network")
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
	if command == "run" && os.Getenv("LOGIN_BROWSER_URL") != "" {
		launcher, err := signinLauncher(spec, log)
		if err != nil {
			log.Fatal().Err(err).Msg("Failed to set up the sign-in browser")
		}
		cfg.Signin = launcher
	}
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
	// Shutdown, on every return from here: the network's background work is stopped
	// (cancelled, then waited for) before the host and its database stop.
	stopBackground := func() {}
	defer func() {
		stopBackground()
		h.Stop()
		log.Info().Msg("Bridge host stopped")
	}()
	if spec.Background != nil {
		stopBackground = spec.Background(ctx, netConn, log)
	}
	switch command {
	case "run":
		log.Info().Str("network", *network).Str("addr", h.Addr()).Msg("Bridge host running")
	case "login":
		if err = terminalLogin(ctx, h, *network, *user, *flow, bridgeKey, os.Stdin); err != nil {
			if errors.Is(err, context.Canceled) {
				log.Warn().Msg("Login interrupted")
			} else {
				log.Error().Err(err).Msg("Login failed")
			}
			exitCode = 1
			return
		}
		log.Info().Msg("Logged in. Messages are being bridged into the journal; run `inspect` in another terminal to read them. Ctrl+C to stop.")
	}
	<-ctx.Done()
}

// signinLauncher sets up the sign-in browser (docs/architecture/signin-browser.md): the
// login-browser service at LOGIN_BROWSER_URL, each browser reaching the web through an egress
// proxy of its own on this host, listening on BRIDGE_EGRESS_BIND (loopback by default) and
// reached at BRIDGE_EGRESS_HOST (by default, that address).
func signinLauncher(spec networks.Network, log zerolog.Logger) (*signin.Launcher, error) {
	if os.Getenv("LOGIN_BROWSER_TOKEN") == "" {
		return nil, errors.New("LOGIN_BROWSER_TOKEN is required with LOGIN_BROWSER_URL")
	}
	plan := &signin.EgressPlan{
		Bind: env("BRIDGE_EGRESS_BIND", "127.0.0.1"), Host: os.Getenv("BRIDGE_EGRESS_HOST"),
		Log: log.With().Str("component", "egress").Logger(),
	}
	if ip, err := netip.ParseAddr(plan.Bind); err != nil {
		return nil, errors.New("BRIDGE_EGRESS_BIND must be an IP address")
	} else if ip.IsUnspecified() && plan.Host == "" {
		return nil, errors.New("BRIDGE_EGRESS_HOST is required when BRIDGE_EGRESS_BIND is every address")
	}
	deny, err := signin.ParseDeny(os.Getenv("BRIDGE_EGRESS_DENY"))
	if err != nil {
		return nil, err
	}
	plan.Deny = deny
	if spec.ProxyEnv != "" {
		if value := os.Getenv(spec.ProxyEnv); value != "" {
			upstream, err := url.Parse(value)
			if err != nil {
				return nil, fmt.Errorf("%s isn't a proxy URL", spec.ProxyEnv)
			}
			plan.Upstream = upstream
		}
	}
	return &signin.Launcher{
		URL: os.Getenv("LOGIN_BROWSER_URL"), Token: os.Getenv("LOGIN_BROWSER_TOKEN"), Egress: plan,
		Log: log.With().Str("component", "signin").Logger(),
	}, nil
}

// logOutput is where the process logs: w, through the network's filter if it has one. A
// network whose connector logs what must not be written out filters the host's log, which is
// the one bridgev2 hands the connector.
func logOutput(network string, w io.Writer) io.Writer {
	if spec, ok := networks.Lookup(network); ok && spec.LogFilter != nil {
		return spec.LogFilter(w)
	}
	return w
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
// showing each step in the terminal and reading what a step asks for from in. It returns as
// soon as ctx ends, even mid-prompt, so the caller's shutdown runs.
func terminalLogin(ctx context.Context, h *host.Host, network, userID, flowID string, bridgeKey seal.KeyPair, in io.Reader) error {
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
	var input *lineReader
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
				values := make(map[string]string)
				fields := step.Fields
				if step.Cookies != nil {
					for _, f := range step.Cookies.Fields {
						fields = append(fields, protocol.LoginField{ID: f.ID, Name: f.ID})
					}
				}
				if input == nil {
					input = newLineReader(in)
				}
				for _, field := range fields {
					fmt.Printf("%s: ", field.Name)
					line, err := input.next(ctx)
					if err != nil {
						fmt.Println()
						return err
					}
					values[field.ID] = strings.TrimSpace(line)
				}
				// Sealed to the bridge key, exactly as a client would.
				sealed, err := seal.SealJSON(protocol.LoginSubmitPlaintext{Input: values}, []seal.PublicKey{bridgeKey.Public},
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

// lineReader reads lines in the background, so a prompt can give up when its context ends:
// a read from a terminal or an open pipe can't itself be interrupted. A read still waiting
// when the process exits is abandoned with it.
type lineReader struct {
	lines chan string
	err   error // set before lines is closed
}

func newLineReader(r io.Reader) *lineReader {
	lr := &lineReader{lines: make(chan string)}
	go func() {
		defer close(lr.lines)
		br := bufio.NewReader(r)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				if line != "" {
					lr.lines <- line
				}
				lr.err = err
				return
			}
			lr.lines <- line
		}
	}()
	return lr
}

// next is the next line, or ctx's error once it ends, or the read's error (io.EOF when the
// input is closed).
func (lr *lineReader) next(ctx context.Context) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case line, ok := <-lr.lines:
		if !ok {
			return "", fmt.Errorf("reading the terminal: %w", lr.err)
		}
		return line, nil
	}
}

// Package host assembles a bridge host process: one network connector under bridgev2,
// Trioditis's MatrixConnector, the journal and its pusher, and the command server.
package host

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream" // registers the sqlite3-fk-wal driver

	_ "github.com/lib/pq"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/bridgev2/commands"
	"maunium.net/go/mautrix/bridgev2/networkid"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/connector"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/gateway"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/keys"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/media"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/server"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/signin"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// Config configures one bridge host process.
type Config struct {
	Network string
	HostID  string
	DataDir string
	// RestoreID names the last restore of this server (deploy/trioditis restore, RESTORE_ID in
	// deploy/.env), if there was one: a database that hasn't settled that one yet holds the
	// backup's queue, which is settled at start rather than run.
	RestoreID string
	// DatabaseType is "sqlite3-fk-wal" (default) or "postgres"; DatabaseURI defaults to a
	// SQLite file in DataDir.
	DatabaseType string
	DatabaseURI  string

	ListenAddr  string
	CommandAddr string

	GatewayURL    string
	InternalToken string
	BridgeKey     seal.KeyPair

	NetworkConnector bridgev2.NetworkConnector
	// KeyFetcher replaces the gateway as the source of recipient keys, for dev and tests.
	KeyFetcher keys.Fetcher
	// AdjustBridgeConfig lets callers change bridgev2's settings: tests, and a network's own
	// backfill pacing.
	AdjustBridgeConfig func(*bridgeconfig.BridgeConfig)
	SendTimeout        time.Duration
	// Signin, if set, runs cookie login steps in the sign-in browser.
	Signin *signin.Launcher

	Log zerolog.Logger
}

// Host is a running bridge host.
type Host struct {
	Config    Config
	DB        *dbutil.Database
	Store     *store.Store
	Keys      *keys.Keys
	Bridge    *bridgev2.Bridge
	Connector *connector.Connector
	Pusher    *gateway.Pusher

	listener   net.Listener
	httpServer *http.Server
	cancel     context.CancelFunc
	done       chan struct{}
	workerDone chan struct{}
	// postStart closes once bridgev2's post-start work is done; stopPostStart cuts it short.
	postStart     chan struct{}
	stopPostStart context.CancelFunc
}

// BridgeConfig is bridgev2's configuration for Trioditis. See docs/PLAN.md, Bridge host.
func BridgeConfig() *bridgeconfig.BridgeConfig {
	everyone := &bridgeconfig.Permissions{SendEvents: true, Login: true, DoublePuppet: true, MaxLogins: 10}
	return &bridgeconfig.BridgeConfig{
		// Nobody sends bridge bot commands in Trioditis. A prefix nobody can type keeps a
		// message that starts with "!wa" from being swallowed as one.
		CommandPrefix: "\x00trioditis-commands-disabled",
		// Each person gets their own copy of a shared chat. Irreversible once portals exist.
		SplitPortals:          true,
		PrivateChatPortalMeta: true,
		// A chat's events are handled synchronously, in the goroutine that queues them. A send
		// is then handed to the connector the moment the bridge host lets it go, right after
		// its deadline is checked, and a chat stuck inside a connector holds only that chat's
		// lane. It also makes mautrix-whatsapp keep whatsmeow's decrypted-event buffer, so a
		// message whose handling a crash cuts off is bridged when WhatsApp redelivers it (see
		// the README, Plaintext at rest).
		PortalEventBuffer: 0,
		// How long a send waits for a login that is reconnecting before it fails. Bounded, so
		// a send checked against its deadline can't wait long after the check.
		SendReconnectWait: connector.SendReconnectWait,
		// A repeated Matrix-side event with the same ID is recognized instead of resent.
		DeduplicateMatrixMessages: true,
		BridgeNotices:             false,
		Permissions:               bridgeconfig.PermissionConfig{ids.ServerName: everyone},
		Backfill: bridgeconfig.BackfillConfig{
			Enabled:              true,
			MaxInitialMessages:   50,
			MaxCatchupMessages:   500,
			UnreadHoursThreshold: 720,
			Queue: bridgeconfig.BackfillQueueConfig{
				Enabled:    true,
				BatchSize:  100,
				BatchDelay: 20,
				MaxBatches: -1,
			},
		},
	}
}

// New builds a host without starting it.
func New(cfg Config) (*Host, error) {
	if cfg.NetworkConnector == nil {
		return nil, errors.New("host: a network connector is required")
	}
	if cfg.HostID == "" {
		cfg.HostID = cfg.Network + "-1"
	}
	if len(cfg.HostID) > 64 {
		return nil, errors.New("host: the host ID is at most 64 characters")
	}
	if cfg.DatabaseType == "" {
		cfg.DatabaseType = "sqlite3-fk-wal"
	}
	if cfg.DatabaseURI == "" {
		cfg.DatabaseURI = "file:" + filepath.Join(cfg.DataDir, cfg.Network+".db") + "?_txlock=immediate"
	}
	db, err := dbutil.NewFromConfig("trioditis-bridge-host-"+cfg.Network, dbutil.Config{PoolConfig: dbutil.PoolConfig{
		Type: cfg.DatabaseType, URI: cfg.DatabaseURI, MaxOpenConns: 5, MaxIdleConns: 1,
	}}, dbutil.ZeroLogger(cfg.Log.With().Str("db_section", "main").Logger()))
	if err != nil {
		return nil, fmt.Errorf("host: failed to open database: %w", err)
	}
	h := &Host{Config: cfg, DB: db}
	h.Store = store.New(db, dbutil.ZeroLogger(cfg.Log.With().Str("db_section", "trioditis").Logger()))
	fetcher := cfg.KeyFetcher
	var client *gateway.Client
	if cfg.GatewayURL != "" {
		client = gateway.NewClient(cfg.GatewayURL, cfg.InternalToken)
		if fetcher == nil {
			fetcher = client
		}
	}
	if fetcher == nil {
		return nil, errors.New("host: a gateway URL or key fetcher is required")
	}
	h.Keys = keys.New(fetcher, h.Store)
	mediaStore, err := media.New(filepath.Join(cfg.DataDir, "media", cfg.Network))
	if err != nil {
		return nil, err
	}
	if client != nil {
		h.Pusher = gateway.NewPusher(client, h.Store, cfg.HostID, cfg.Network, cfg.CommandAddr, cfg.Log.With().Str("component", "pusher").Logger())
	}
	notify := func() {}
	if h.Pusher != nil {
		notify = h.Pusher.Wake
	}
	h.Connector = connector.New(connector.Options{
		Network: cfg.Network, Store: h.Store, Keys: h.Keys, Media: mediaStore,
		BridgeKey: cfg.BridgeKey,
		Notify:    notify, SendTimeout: cfg.SendTimeout, Signin: cfg.Signin,
	})
	bridgeCfg := BridgeConfig()
	if cfg.AdjustBridgeConfig != nil {
		cfg.AdjustBridgeConfig(bridgeCfg)
	}
	h.Bridge = bridgev2.NewBridge(networkid.BridgeID(cfg.Network), db, cfg.Log, bridgeCfg, h.Connector, cfg.NetworkConnector,
		// bridgev2's own command processor: the WhatsApp connector registers commands on it
		// and asserts its type. The unreachable prefix above means it never runs.
		func(br *bridgev2.Bridge) bridgev2.CommandProcessor { return commands.NewProcessor(br) })
	return h, nil
}

// Start upgrades the database, starts the network connector and logins, and begins
// serving commands and pushing events.
func (h *Host) Start(ctx context.Context) error {
	if err := h.Store.Upgrade(ctx); err != nil {
		return fmt.Errorf("host: failed to upgrade Trioditis tables: %w", err)
	}
	// Opaque IDs are hashed with a key kept in the database, so they survive a new bridge
	// key. A database from before the key existed keeps the IDs it has.
	idKey, err := h.Store.IDKey(ctx, ids.LegacyOpaqueKey(h.Config.BridgeKey.Private[:]))
	if err != nil {
		return fmt.Errorf("host: failed to load the ID key: %w", err)
	}
	h.Connector.Opaque = ids.NewOpaquer(idKey)
	if err = h.Connector.MarkInFlightUnknown(ctx); err != nil {
		return fmt.Errorf("host: failed to settle interrupted sends: %w", err)
	}
	// A crash between an acknowledgement and its scrub, in an older version, could leave a
	// login code behind; whatever the gateway has is scrubbed at every start.
	if acked, err := h.Store.AckedThrough(ctx); err != nil {
		return fmt.Errorf("host: failed to read the journal state: %w", err)
	} else if err = h.Store.ScrubLoginDisplays(ctx, acked); err != nil {
		return fmt.Errorf("host: failed to scrub login codes: %w", err)
	}
	// bridgev2.Start, with its post-start work tracked so Stop can wait for it.
	bridgeCtx := h.Bridge.Log.WithContext(ctx)
	if err = h.Bridge.StartConnectors(bridgeCtx); err == nil {
		err = h.Bridge.StartLogins(bridgeCtx)
	}
	if err != nil {
		return fmt.Errorf("host: failed to start bridge: %w", err)
	}
	postCtx, stopPostStart := context.WithCancel(bridgeCtx)
	h.postStart, h.stopPostStart = make(chan struct{}), stopPostStart
	go func() {
		defer close(h.postStart)
		h.Bridge.PostStart(postCtx)
	}()
	// Restored from a backup since this database last started: the queue in it is the backup's,
	// so nothing it holds runs (SettleRestored). Every restore names itself (RestoreID, from
	// deploy/.env), and the database keeps the last one it settled, so the decision follows
	// the queue itself, whichever volumes the backup had. The ID is recorded only once every
	// such command is settled and its status is in the journal, which the pusher delivers; a
	// start that stops before then settles again on the next one.
	if h.Config.RestoreID != "" {
		settled, err := h.Store.SettledRestore(ctx)
		if err != nil {
			return fmt.Errorf("host: failed to read the last restore settled: %w", err)
		}
		if settled != h.Config.RestoreID {
			if err = h.Connector.SettleRestored(ctx); err != nil {
				return fmt.Errorf("host: failed to settle the restored commands: %w", err)
			}
			if err = h.Store.SetSettledRestore(ctx, h.Config.RestoreID); err != nil {
				return fmt.Errorf("host: failed to record the restore as settled: %w", err)
			}
		}
	}
	if err = h.Connector.RecoverCommands(ctx); err != nil {
		return fmt.Errorf("host: failed to recover interrupted commands: %w", err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan struct{})
	h.workerDone = make(chan struct{})
	go func() {
		defer close(h.workerDone)
		h.Connector.RunWorker(runCtx)
	}()
	if h.Pusher != nil {
		go func() {
			defer close(h.done)
			h.Pusher.Run(runCtx)
		}()
	} else {
		close(h.done)
	}
	if h.Config.ListenAddr != "" {
		listener, err := net.Listen("tcp", h.Config.ListenAddr)
		if err != nil {
			return fmt.Errorf("host: failed to listen: %w", err)
		}
		h.listener = listener
		srv := &server.Server{Token: h.Config.InternalToken, Handler: h.Connector, Browsers: h.Connector, Media: h.Connector.Media, Log: h.Config.Log.With().Str("component", "server").Logger()}
		if h.Config.Signin != nil {
			srv.Refuse = signin.FromBrowser(h.Config.Signin.URL)
		}
		h.httpServer = &http.Server{Handler: srv.Routes(), ReadHeaderTimeout: 10 * time.Second}
		go func() {
			if err := h.httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				h.Config.Log.Err(err).Msg("Command server stopped")
			}
		}()
	}
	return nil
}

// Addr is the command server's listening address.
func (h *Host) Addr() string {
	if h.listener == nil {
		return ""
	}
	return h.listener.Addr().String()
}

// Stop shuts everything down.
func (h *Host) Stop() {
	if h.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = h.httpServer.Shutdown(ctx)
		cancel()
	}
	// bridgev2's post-start work (resending bridge info) uses the database, which bridgev2's stop
	// closes: it is told to stop, and waited for, first.
	if h.postStart != nil {
		h.stopPostStart()
		<-h.postStart
	}
	h.Bridge.StopWithTimeout(10 * time.Second)
	if h.cancel != nil {
		h.cancel()
		<-h.done
		<-h.workerDone
	}
	_ = h.DB.Close()
}

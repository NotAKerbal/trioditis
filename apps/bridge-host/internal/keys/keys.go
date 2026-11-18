// Package keys finds the public keys to seal a person's objects to.
//
// Keys come from the gateway and are cached for a minute in memory and indefinitely in the
// database. bridgev2 doesn't retry an event whose delivery to "Matrix" failed, so if the
// gateway is unreachable the bridge host keeps sealing with the last keys it knew rather
// than dropping the message.
package keys

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/store"
)

// TTL is how long fetched keys are trusted before asking the gateway again.
const TTL = 60 * time.Second

// GrantTTL is how long agent grants from the last fetch are honoured while the gateway is
// unreachable. After that only the person's identity key is used: a revoked grant mustn't
// keep sealing messages to the agent-access key through a long outage.
const GrantTTL = 10 * time.Minute

// ErrNoIdentityKey means the person hasn't finished device setup, so nothing can be sealed
// to them yet.
var ErrNoIdentityKey = errors.New("keys: the person has no identity key yet")

// Fetcher gets a person's current keys, from the gateway in production.
type Fetcher interface {
	FetchKeys(ctx context.Context, userID string) (*protocol.RecipientKeys, error)
}

type cached struct {
	keys    *protocol.RecipientKeys
	fetched time.Time
}

// Keys resolves and caches recipient keys.
type Keys struct {
	Fetcher Fetcher
	Store   *store.Store

	lock  sync.Mutex
	cache map[string]cached
}

func New(fetcher Fetcher, st *store.Store) *Keys {
	return &Keys{Fetcher: fetcher, Store: st, cache: make(map[string]cached)}
}

// For returns a person's keys.
func (k *Keys) For(ctx context.Context, userID string) (*protocol.RecipientKeys, error) {
	k.lock.Lock()
	entry, ok := k.cache[userID]
	k.lock.Unlock()
	if ok && time.Since(entry.fetched) < TTL {
		return entry.keys, nil
	}
	fresh, err := k.Fetcher.FetchKeys(ctx, userID)
	if err == nil {
		k.lock.Lock()
		k.cache[userID] = cached{keys: fresh, fetched: time.Now()}
		k.lock.Unlock()
		if putErr := k.Store.PutRecipientKeys(ctx, userID, fresh); putErr != nil {
			zerolog.Ctx(ctx).Warn().Err(putErr).Msg("Failed to cache recipient keys")
		}
		return fresh, nil
	} else if errors.Is(err, ErrNoIdentityKey) {
		return nil, err
	}
	stale, fetchedAt, storeErr := k.Store.GetRecipientKeys(ctx, userID)
	if storeErr != nil {
		return nil, errors.Join(err, storeErr)
	}
	if time.Since(fetchedAt) > GrantTTL {
		identityOnly := *stale
		identityOnly.AgentGrantedPortals = nil
		stale = &identityOnly
	}
	zerolog.Ctx(ctx).Warn().Err(err).Str("user_id", userID).Msg("Gateway unreachable, sealing with last known keys")
	return stale, nil
}

// Recipients returns the public keys an object in the given portal is sealed to: the
// person's identity key, plus the agent-access key if the portal is granted to an agent.
func (k *Keys) Recipients(ctx context.Context, userID, portalID string) ([]seal.PublicKey, error) {
	keys, err := k.For(ctx, userID)
	if err != nil {
		return nil, err
	}
	identity, err := seal.ParsePublicKey(keys.Identity.PublicKey)
	if err != nil {
		return nil, err
	}
	out := []seal.PublicKey{identity}
	if portalID != "" && slices.Contains(keys.AgentGrantedPortals, portalID) && keys.AgentAccess.PublicKey != "" {
		agent, err := seal.ParsePublicKey(keys.AgentAccess.PublicKey)
		if err != nil {
			return nil, err
		}
		out = append(out, agent)
	}
	return out, nil
}

// Has reports whether the person has an identity key, for refusing logins otherwise.
func (k *Keys) Has(ctx context.Context, userID string) (bool, error) {
	_, err := k.For(ctx, userID)
	if errors.Is(err, ErrNoIdentityKey) {
		return false, nil
	}
	return err == nil, err
}

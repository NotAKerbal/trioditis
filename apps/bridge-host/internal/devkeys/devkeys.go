// Package devkeys stands in for the gateway's key endpoint when trying the bridge host on
// its own. It keeps a dev identity key pair per person in the data directory. Never use it
// in production: the private keys are on the server, which is exactly what sealing avoids.
package devkeys

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

type file struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// Keys is a keys.Fetcher backed by files.
type Keys struct {
	Dir string
}

func (k *Keys) path(userID string) (string, error) {
	if userID == "" || strings.ContainsAny(userID, `/\.`) {
		return "", errors.New("devkeys: invalid user ID")
	}
	return filepath.Join(k.Dir, userID+".json"), nil
}

// KeyPair loads, or creates, a person's dev identity key pair.
func (k *Keys) KeyPair(userID string) (seal.KeyPair, error) {
	path, err := k.path(userID)
	if err != nil {
		return seal.KeyPair{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		kp, err := seal.GenerateKeyPair()
		if err != nil {
			return kp, err
		}
		if err = os.MkdirAll(k.Dir, 0o700); err != nil {
			return kp, err
		}
		data, _ = json.Marshal(file{PublicKey: kp.Public.String(), PrivateKey: seal.Encode(kp.Private[:])})
		return kp, os.WriteFile(path, data, 0o600)
	} else if err != nil {
		return seal.KeyPair{}, err
	}
	var f file
	if err = json.Unmarshal(data, &f); err != nil {
		return seal.KeyPair{}, err
	}
	return seal.ParseKeyPair(f.PublicKey, f.PrivateKey)
}

// FetchKeys returns a person's dev public key, creating the key pair on first use.
func (k *Keys) FetchKeys(ctx context.Context, userID string) (*protocol.RecipientKeys, error) {
	kp, err := k.KeyPair(userID)
	if err != nil {
		return nil, err
	}
	return &protocol.RecipientKeys{
		Identity:            protocol.RecipientKey{KID: kp.Public.KeyID(), PublicKey: kp.Public.String()},
		AgentGrantedPortals: []string{},
	}, nil
}

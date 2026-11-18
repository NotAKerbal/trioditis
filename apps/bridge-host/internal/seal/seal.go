// Package seal implements Trioditis sealing, docs/architecture/sealing.md: content is
// encrypted with a fresh content key, and only that key is sealed to each recipient, so the
// bridge host can encrypt to a person but can never decrypt what it stored. It must stay
// byte-compatible with packages/crypto; both are tested against the shared vectors.
package seal

import (
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

const (
	Version = 1

	contentKeyBytes = 32
	keyIDBytes      = 16
)

// Kind names the type of object a sealed envelope belongs to. It is part of the
// associated data, so an envelope can't be passed off as another kind of object.
type Kind string

const (
	KindMessage  Kind = "message"
	KindChat     Kind = "chat"
	KindContact  Kind = "contact"
	KindDraft    Kind = "draft"
	KindOutbound Kind = "outbound"
	KindMedia    Kind = "media"
)

// Context is the row a sealed object belongs to. It is bound into the ciphertext.
type Context struct {
	Kind        Kind   `json:"kind"`
	OwnerUserID string `json:"ownerUserId"`
	ObjectID    string `json:"objectId"`
}

var (
	ErrNotRecipient    = errors.New("seal: this key is not a recipient of the envelope")
	ErrDecrypt         = errors.New("seal: the envelope could not be decrypted for this object")
	ErrNoRecipients    = errors.New("seal: a sealed object needs at least one recipient")
	ErrBadContext      = errors.New("seal: a sealed object needs an owner and an ID")
	ErrLastRecipient   = errors.New("seal: the envelope's last recipient can't be removed")
	ErrVersion         = errors.New("seal: unsupported envelope version")
	ErrInvalidEncoding = errors.New("seal: invalid base64url")
)

// AssociatedData is `trioditis/v1/<kind>/<ownerUserId>/<objectId>`.
func (c Context) AssociatedData() ([]byte, error) {
	if c.OwnerUserID == "" || c.ObjectID == "" {
		return nil, ErrBadContext
	}
	return []byte(fmt.Sprintf("trioditis/v1/%s/%s/%s", c.Kind, c.OwnerUserID, c.ObjectID)), nil
}

// PublicKey is an X25519 public key.
type PublicKey [32]byte

// KeyPair is an X25519 key pair, as libsodium's crypto_box makes them.
type KeyPair struct {
	Public  PublicKey
	Private [32]byte
}

func encode(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// Decode reads base64url without padding, the encoding every binary field uses.
func Decode(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, ErrInvalidEncoding
	}
	return b, nil
}

// Encode writes base64url without padding.
func Encode(b []byte) string { return encode(b) }

// ParsePublicKey reads a base64url public key.
func ParsePublicKey(s string) (PublicKey, error) {
	var pk PublicKey
	b, err := Decode(s)
	if err != nil {
		return pk, err
	} else if len(b) != len(pk) {
		return pk, fmt.Errorf("seal: public key is %d bytes, not 32", len(b))
	}
	copy(pk[:], b)
	return pk, nil
}

// ParseKeyPair reads a base64url private key and checks it matches the public key.
func ParseKeyPair(publicKey, privateKey string) (KeyPair, error) {
	var kp KeyPair
	pub, err := ParsePublicKey(publicKey)
	if err != nil {
		return kp, err
	}
	priv, err := Decode(privateKey)
	if err != nil {
		return kp, err
	} else if len(priv) != 32 {
		return kp, fmt.Errorf("seal: private key is %d bytes, not 32", len(priv))
	}
	copy(kp.Private[:], priv)
	derived, err := curve25519.X25519(kp.Private[:], curve25519.Basepoint)
	if err != nil {
		return kp, err
	}
	copy(kp.Public[:], derived)
	if kp.Public != pub {
		return kp, errors.New("seal: the public key doesn't match the private key")
	}
	return kp, nil
}

// String is the base64url public key.
func (pk PublicKey) String() string { return encode(pk[:]) }

// KeyID is the first 16 bytes of BLAKE2b-256 of the public key, base64url.
func (pk PublicKey) KeyID() string {
	sum := blake2b.Sum256(pk[:])
	return encode(sum[:keyIDBytes])
}

// GenerateKeyPair makes a random X25519 key pair.
func GenerateKeyPair() (KeyPair, error) {
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{Public: *pub, Private: *priv}, nil
}

// SeedKeyPair derives a key pair the way libsodium's crypto_box_seed_keypair does: the
// private key is the first 32 bytes of SHA-512 of the seed. Used for test vectors, so key
// IDs agree with packages/crypto.
func SeedKeyPair(seed []byte) KeyPair {
	sum := sha512.Sum512(seed)
	var kp KeyPair
	copy(kp.Private[:], sum[:32])
	pub, err := curve25519.X25519(kp.Private[:], curve25519.Basepoint)
	if err != nil {
		// X25519 with the base point never fails for a 32-byte scalar.
		panic(err)
	}
	copy(kp.Public[:], pub)
	return kp
}

// EnvelopeKey is the content key sealed to one recipient.
type EnvelopeKey struct {
	KID string `json:"kid"`
	SK  string `json:"sk"`
}

// Envelope is a sealed object, envelope v1.
type Envelope struct {
	V     int           `json:"v"`
	Nonce string        `json:"nonce"`
	CT    string        `json:"ct"`
	Keys  []EnvelopeKey `json:"keys"`
}

func sealContentKey(contentKey []byte, recipient PublicKey) (EnvelopeKey, error) {
	pk := [32]byte(recipient)
	sealed, err := box.SealAnonymous(nil, contentKey, &pk, rand.Reader)
	if err != nil {
		return EnvelopeKey{}, err
	}
	return EnvelopeKey{KID: recipient.KeyID(), SK: encode(sealed)}, nil
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// Seal encrypts plaintext for every recipient and forgets the content key.
func Seal(plaintext []byte, recipients []PublicKey, ctx Context) (*Envelope, error) {
	if len(recipients) == 0 {
		return nil, ErrNoRecipients
	}
	ad, err := ctx.AssociatedData()
	if err != nil {
		return nil, err
	}
	contentKey := make([]byte, contentKeyBytes)
	defer zero(contentKey)
	if _, err = io.ReadFull(rand.Reader, contentKey); err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(contentKey)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	env := &Envelope{
		V:     Version,
		Nonce: encode(nonce),
		CT:    encode(aead.Seal(nil, nonce, plaintext, ad)),
	}
	seen := make(map[string]struct{}, len(recipients))
	for _, recipient := range recipients {
		if _, dup := seen[recipient.KeyID()]; dup {
			continue
		}
		seen[recipient.KeyID()] = struct{}{}
		key, err := sealContentKey(contentKey, recipient)
		if err != nil {
			return nil, err
		}
		env.Keys = append(env.Keys, key)
	}
	return env, nil
}

// SealJSON seals the JSON encoding of value.
func SealJSON(value any, recipients []PublicKey, ctx Context) (*Envelope, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	defer zero(data)
	return Seal(data, recipients, ctx)
}

func (env *Envelope) openContentKey(kp KeyPair) ([]byte, error) {
	if env.V != Version {
		return nil, fmt.Errorf("%w %d", ErrVersion, env.V)
	}
	kid := kp.Public.KeyID()
	for _, key := range env.Keys {
		if key.KID != kid {
			continue
		}
		sealed, err := Decode(key.SK)
		if err != nil {
			return nil, err
		}
		pub, priv := [32]byte(kp.Public), kp.Private
		contentKey, ok := box.OpenAnonymous(nil, sealed, &pub, &priv)
		if !ok {
			return nil, ErrDecrypt
		}
		return contentKey, nil
	}
	return nil, ErrNotRecipient
}

func (env *Envelope) decrypt(contentKey []byte, ctx Context) ([]byte, error) {
	ad, err := ctx.AssociatedData()
	if err != nil {
		return nil, err
	}
	nonce, err := Decode(env.Nonce)
	if err != nil {
		return nil, err
	}
	ct, err := Decode(env.CT)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(contentKey)
	if err != nil {
		return nil, err
	} else if len(nonce) != aead.NonceSize() {
		return nil, ErrDecrypt
	}
	plaintext, err := aead.Open(nil, nonce, ct, ad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}

// Open decrypts the envelope with kp, which must be one of its recipients.
func Open(env *Envelope, kp KeyPair, ctx Context) ([]byte, error) {
	contentKey, err := env.openContentKey(kp)
	if err != nil {
		return nil, err
	}
	defer zero(contentKey)
	return env.decrypt(contentKey, ctx)
}

// OpenJSON decrypts the envelope and unmarshals it into out.
func OpenJSON(env *Envelope, kp KeyPair, ctx Context, out any) error {
	plaintext, err := Open(env, kp, ctx)
	if err != nil {
		return err
	}
	defer zero(plaintext)
	return json.Unmarshal(plaintext, out)
}

// AddRecipient shares the envelope with another key without re-encrypting the content.
// kp must already be a recipient; the content is checked first, so a corrupt envelope is
// never re-shared.
func AddRecipient(env *Envelope, kp KeyPair, recipient PublicKey, ctx Context) (*Envelope, error) {
	contentKey, err := env.openContentKey(kp)
	if err != nil {
		return nil, err
	}
	defer zero(contentKey)
	if _, err = env.decrypt(contentKey, ctx); err != nil {
		return nil, err
	}
	for _, key := range env.Keys {
		if key.KID == recipient.KeyID() {
			return env, nil
		}
	}
	key, err := sealContentKey(contentKey, recipient)
	if err != nil {
		return nil, err
	}
	out := *env
	out.Keys = append(append([]EnvelopeKey{}, env.Keys...), key)
	return &out, nil
}

// RemoveRecipient drops a recipient. The last recipient can't be removed.
func RemoveRecipient(env *Envelope, kid string) (*Envelope, error) {
	if env.V != Version {
		return nil, fmt.Errorf("%w %d", ErrVersion, env.V)
	}
	keys := make([]EnvelopeKey, 0, len(env.Keys))
	for _, key := range env.Keys {
		if key.KID != kid {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil, ErrLastRecipient
	}
	out := *env
	out.Keys = keys
	return &out, nil
}

// EncryptedMedia is a file encrypted with its own key. The key and nonce go inside the
// sealed message plaintext, never next to the file.
type EncryptedMedia struct {
	Ciphertext []byte
	Key        string
	Nonce      string
}

func mediaAD(ownerUserID, mediaID string) ([]byte, error) {
	return Context{Kind: KindMedia, OwnerUserID: ownerUserID, ObjectID: mediaID}.AssociatedData()
}

// EncryptMedia encrypts a file, bound to its owner and media ID.
func EncryptMedia(data []byte, ownerUserID, mediaID string) (*EncryptedMedia, error) {
	ad, err := mediaAD(ownerUserID, mediaID)
	if err != nil {
		return nil, err
	}
	key := make([]byte, contentKeyBytes)
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err = io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	return &EncryptedMedia{Ciphertext: aead.Seal(nil, nonce, data, ad), Key: encode(key), Nonce: encode(nonce)}, nil
}

// DecryptMedia reverses EncryptMedia.
func DecryptMedia(ciphertext []byte, key, nonce, ownerUserID, mediaID string) ([]byte, error) {
	ad, err := mediaAD(ownerUserID, mediaID)
	if err != nil {
		return nil, err
	}
	k, err := Decode(key)
	if err != nil {
		return nil, err
	}
	n, err := Decode(nonce)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(k)
	if err != nil {
		return nil, err
	} else if len(n) != aead.NonceSize() {
		return nil, ErrDecrypt
	}
	plaintext, err := aead.Open(nil, n, ciphertext, ad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}

// Package media is the bridge host's encrypted media store.
//
// Connectors upload files before the message that uses them exists, and bridgev2 often
// doesn't say which chat a file belongs to (avatars are uploaded with no room). A file's
// key must only ever travel inside sealed plaintext, never next to the file, so the store
// keeps a connector's upload in memory, briefly, until a sealed object references it. At
// that point it encrypts a copy for the person the object is sealed to, writes only the
// ciphertext to disk, and hands the key to the caller to put in the sealed plaintext.
//
// Each sealed copy is written under its owner's directory, so the gateway can fetch it for
// them (Open) and nobody else: the ciphertext goes to the client, which has the key.
//
// Outbound attachments go the other way: the client encrypted the file, and the key
// arrives in a sealed send. Register makes it readable for the length of the send.
package media

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"maunium.net/go/mautrix/id"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/ids"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/protocol"
	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/seal"
)

// UploadTTL is how long an upload's plaintext stays in memory waiting to be referenced.
const UploadTTL = 10 * time.Minute

var ErrUnavailable = errors.New("media: file is not available")

// ErrCorrupt is a kept copy (Keep) whose file doesn't decrypt: it can never make a copy again.
var ErrCorrupt = errors.New("media: kept copy is corrupt")

type upload struct {
	data    []byte
	name    string
	mime    string
	expires time.Time
	copies  map[string]protocol.Attachment // per owner user ID
	kept    *protocol.Attachment           // the bridge host's own copy (Keep), once made
}

// registered is one send's file: its own entry, under an ID made for the send, so two sends
// naming the same media ID never read each other's file or key.
type registered struct {
	mediaID, owner, key, nonce string
	expires                    time.Time
}

// Store is the encrypted media store.
type Store struct {
	dir string

	lock       sync.Mutex
	uploads    map[string]*upload
	registered map[string]*registered
	budget     *budget
}

// SendBudget is how many bytes the files of sends being sent may hold in memory at once,
// their ciphertext and plaintext both: a few large files, so many sends of them at once can't
// run the bridge host out of memory. A send waits for its share (Reserve).
const SendBudget = 512 << 20

// New opens a store in dir, creating it if needed.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{
		dir: dir, uploads: make(map[string]*upload), registered: make(map[string]*registered),
		budget: newBudget(SendBudget),
	}, nil
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = io.ReadFull(rand.Reader, b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// ContentURI is the Matrix content URI for a media ID.
func ContentURI(mediaID string) id.ContentURIString {
	return id.ContentURIString("mxc://" + ids.ServerName + "/" + mediaID)
}

// ParseContentURI returns the media ID of one of the store's content URIs.
func ParseContentURI(uri id.ContentURIString) (string, bool) {
	rest, ok := strings.CutPrefix(string(uri), "mxc://"+ids.ServerName+"/")
	if !ok || rest == "" || strings.ContainsAny(rest, "/.") {
		return "", false
	}
	return rest, true
}

func (s *Store) path(mediaID string) string {
	return filepath.Join(s.dir, mediaID)
}

// ownerDir is where an owner's sealed copies are written. It is named by a hash, so a user ID
// is never part of a path.
func (s *Store) ownerDir(ownerUserID string) string {
	sum := sha256.Sum256([]byte("trioditis/media-owner/" + ownerUserID))
	return filepath.Join(s.dir, "owners", hex.EncodeToString(sum[:16]))
}

// validID reports whether mediaID is one the store could have made, so it is safe in a path.
func validID(mediaID string) bool {
	if len(mediaID) < 16 || len(mediaID) > 64 {
		return false
	}
	for _, r := range mediaID {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (s *Store) sweepLocked(now time.Time) {
	for key, up := range s.uploads {
		if now.After(up.expires) {
			clear(up.data)
			delete(s.uploads, key)
		}
	}
	for key, reg := range s.registered {
		if now.After(reg.expires) {
			delete(s.registered, key)
		}
	}
}

// Upload holds a connector's file in memory and returns a content URI for it.
func (s *Store) Upload(data []byte, name, mime string) id.ContentURIString {
	mediaID := randomID()
	s.lock.Lock()
	defer s.lock.Unlock()
	s.sweepLocked(time.Now())
	s.uploads[mediaID] = &upload{
		data:    append([]byte(nil), data...),
		name:    name,
		mime:    mime,
		expires: time.Now().Add(UploadTTL),
		copies:  make(map[string]protocol.Attachment),
	}
	return ContentURI(mediaID)
}

// Available reports whether an upload is still in memory.
func (s *Store) Available(uri id.ContentURIString) bool {
	mediaID, ok := ParseContentURI(uri)
	if !ok {
		return false
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	up, ok := s.uploads[mediaID]
	return ok && !time.Now().After(up.expires)
}

// AttachmentFor encrypts a copy of an upload for ownerUserID and returns the attachment
// to put in the sealed plaintext. Repeated calls for the same owner reuse the copy.
func (s *Store) AttachmentFor(uri id.ContentURIString, ownerUserID string) (*protocol.Attachment, error) {
	mediaID, ok := ParseContentURI(uri)
	if !ok {
		return nil, ErrUnavailable
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	up, ok := s.uploads[mediaID]
	if !ok || time.Now().After(up.expires) {
		return nil, ErrUnavailable
	}
	if att, ok := up.copies[ownerUserID]; ok {
		return &att, nil
	}
	att, err := s.writeCopy(s.ownerDir(ownerUserID), ownerUserID, up.data, up.name, up.mime)
	if err != nil {
		return nil, err
	}
	up.copies[ownerUserID] = *att
	return att, nil
}

// KeptOwner is who a kept copy (Keep) is encrypted for, in its associated data: the bridge
// host itself. It can't be a user's ID, which never has a slash.
const KeptOwner = "trioditis/bridge-host"

// keptDir is where kept copies are written. Nothing serves it: Open reads only owners'
// directories and media IDs, which can't name a directory.
func (s *Store) keptDir() string { return filepath.Join(s.dir, "kept") }

// Keep encrypts a copy of an upload for the bridge host itself and returns its reference,
// for the caller to seal to the bridge key. It is how an avatar outlives its upload for
// people the host hasn't sent it to yet: the bridge often uploads a contact's picture long
// before the contact turns up in anyone's chat. Repeated calls reuse the copy.
func (s *Store) Keep(uri id.ContentURIString) (*protocol.Attachment, error) {
	mediaID, ok := ParseContentURI(uri)
	if !ok {
		return nil, ErrUnavailable
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	up, ok := s.uploads[mediaID]
	if !ok || time.Now().After(up.expires) {
		return nil, ErrUnavailable
	}
	if up.kept != nil {
		att := *up.kept
		return &att, nil
	}
	att, err := s.writeCopy(s.keptDir(), KeptOwner, up.data, up.name, up.mime)
	if err != nil {
		return nil, err
	}
	up.kept = att
	kept := *att
	return &kept, nil
}

// HasKept reports whether a kept copy's file is still there.
func (s *Store) HasKept(kept protocol.Attachment) bool {
	if !validID(kept.MediaID) {
		return false
	}
	info, err := os.Lstat(filepath.Join(s.keptDir(), kept.MediaID))
	return err == nil && info.Mode().IsRegular()
}

// CopyKept encrypts a new copy of a kept file (Keep) for ownerUserID, as AttachmentFor would
// have while its upload lived. The plaintext is only ever in memory.
func (s *Store) CopyKept(kept protocol.Attachment, ownerUserID string) (*protocol.Attachment, error) {
	if !validID(kept.MediaID) || ownerUserID == "" {
		return nil, ErrUnavailable
	}
	ct, err := readNoFollow(filepath.Join(s.keptDir(), kept.MediaID))
	if err != nil {
		return nil, ErrUnavailable
	}
	data, err := seal.DecryptMedia(ct, kept.Key, kept.Nonce, KeptOwner, kept.MediaID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrCorrupt, err)
	}
	defer clear(data)
	return s.writeCopy(s.ownerDir(ownerUserID), ownerUserID, data, kept.Name, kept.Mime)
}

// KeepCopy makes the bridge host's own copy (as Keep does) from a copy made for ownerUserID,
// once the upload is gone. The plaintext is only ever in memory.
func (s *Store) KeepCopy(att protocol.Attachment, ownerUserID string) (*protocol.Attachment, error) {
	if !validID(att.MediaID) || ownerUserID == "" {
		return nil, ErrUnavailable
	}
	// In the owner's directory, or for a copy made before owners had directories, the store's own.
	ct, err := readNoFollow(filepath.Join(s.ownerDir(ownerUserID), att.MediaID))
	if errors.Is(err, os.ErrNotExist) {
		ct, err = readNoFollow(s.path(att.MediaID))
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	data, err := seal.DecryptMedia(ct, att.Key, att.Nonce, ownerUserID, att.MediaID)
	if err != nil {
		return nil, err
	}
	defer clear(data)
	return s.writeCopy(s.keptDir(), KeptOwner, data, att.Name, att.Mime)
}

// writeCopy encrypts data for ownerUserID under a new media ID and writes the ciphertext in dir.
func (s *Store) writeCopy(dir, ownerUserID string, data []byte, name, mime string) (*protocol.Attachment, error) {
	copyID := randomID()
	enc, err := seal.EncryptMedia(data, ownerUserID, copyID)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("media: failed to make the copy's directory: %w", err)
	}
	if err = writeNew(filepath.Join(dir, copyID), enc.Ciphertext); err != nil {
		return nil, fmt.Errorf("media: failed to write file: %w", err)
	}
	return &protocol.Attachment{MediaID: copyID, Mime: mime, Size: len(data), Name: name, Key: enc.Key, Nonce: enc.Nonce}, nil
}

// MaxClientFile is the largest ciphertext a client may put here to send: a 100 MiB file and its
// 16-byte tag. That's about what the networks take as a document, and still small enough to
// hold in memory while it's sent.
const MaxClientFile = 100<<20 + 16

// ErrExists is a put under a media ID already in use. Nothing is replaced.
var ErrExists = errors.New("media: a file with that ID exists")

// ErrTooLarge is a put of more than MaxClientFile bytes.
var ErrTooLarge = errors.New("media: file is too large")

// Put writes the ciphertext of a file a client encrypted for its owner, to send. It goes in
// the owner's directory, so only they can fetch it (Open) or have it read for their send
// (Register). It is written in full under another name first, so a send never reads half of
// one, and a media ID already used is refused rather than replaced.
func (s *Store) Put(mediaID, ownerUserID string, r io.Reader) error {
	if !validID(mediaID) || ownerUserID == "" {
		return ErrUnavailable
	}
	dir := s.ownerDir(ownerUserID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("media: failed to make the owner's directory: %w", err)
	}
	final := filepath.Join(dir, mediaID)
	if _, err := os.Lstat(final); err == nil {
		return ErrExists
	}
	tmp, err := os.OpenFile(filepath.Join(dir, ".put-"+randomID()), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("media: failed to make the file: %w", err)
	}
	defer os.Remove(tmp.Name())
	n, err := io.Copy(tmp, io.LimitReader(r, MaxClientFile+1))
	if err == nil && n > MaxClientFile {
		err = ErrTooLarge
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	// A link never replaces what's there, so two puts of one ID can't both land.
	if err = os.Link(tmp.Name(), final); errors.Is(err, os.ErrExist) {
		return ErrExists
	}
	return err
}

// Register makes a client-encrypted file readable for a while, for an outbound send whose
// sealed plaintext carried its key. It returns the content URI to give the connector: one of
// its own, which reads only this owner's file with this key.
func (s *Store) Register(att protocol.Attachment, ownerUserID string, ttl time.Duration) (id.ContentURIString, error) {
	if _, ok := ParseContentURI(ContentURI(att.MediaID)); !ok {
		return "", fmt.Errorf("media: invalid media ID")
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	s.sweepLocked(time.Now())
	regID := randomID()
	s.registered[regID] = &registered{mediaID: att.MediaID, owner: ownerUserID, key: att.Key, nonce: att.Nonce, expires: time.Now().Add(ttl)}
	return ContentURI(regID), nil
}

// Reserve waits for a send's file to have its share of SendBudget, and returns how to give it
// back once the send is done with the file. A file already in memory (a connector's upload)
// needs none.
func (s *Store) Reserve(ctx context.Context, uri id.ContentURIString) (func(), error) {
	regID, ok := ParseContentURI(uri)
	if !ok {
		return func() {}, nil
	}
	s.lock.Lock()
	reg, isRegistered := s.registered[regID]
	s.lock.Unlock()
	if !isRegistered {
		return func() {}, nil
	}
	info, err := os.Lstat(filepath.Join(s.ownerDir(reg.owner), reg.mediaID))
	if errors.Is(err, os.ErrNotExist) {
		info, err = os.Lstat(s.path(reg.mediaID))
	}
	if err != nil {
		// Nothing to read: Read says so.
		return func() {}, nil
	}
	return s.budget.acquire(ctx, 2*info.Size())
}

// Read returns a file's plaintext: an upload still in memory, or a registered file
// decrypted from disk. Plaintext from disk is only ever held in memory.
func (s *Store) Read(uri id.ContentURIString) ([]byte, error) {
	mediaID, ok := ParseContentURI(uri)
	if !ok {
		return nil, ErrUnavailable
	}
	// Expiry is checked, and an upload copied, under the lock the sweep clears data under.
	s.lock.Lock()
	now := time.Now()
	up, isUpload := s.uploads[mediaID]
	if isUpload && now.After(up.expires) {
		isUpload = false
	}
	var data []byte
	if isUpload {
		data = append([]byte(nil), up.data...)
	}
	reg, isRegistered := s.registered[mediaID]
	if isRegistered && now.After(reg.expires) {
		isRegistered = false
	}
	var key, nonce, owner string
	if isRegistered {
		mediaID, key, nonce, owner = reg.mediaID, reg.key, reg.nonce, reg.owner
	}
	s.lock.Unlock()
	if isUpload {
		return data, nil
	} else if !isRegistered {
		return nil, ErrUnavailable
	}
	// A file the client put is in its owner's directory (Put); one from before that, in the
	// store's own. Either way it opens only with the owner's key and associated data. The ID
	// is safe in a path: ParseContentURI refuses one with a separator or a dot.
	ct, err := readNoFollow(filepath.Join(s.ownerDir(owner), mediaID))
	if errors.Is(err, os.ErrNotExist) {
		ct, err = readNoFollow(s.path(mediaID))
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	return seal.DecryptMedia(ct, key, nonce, owner, mediaID)
}

// Open opens the ciphertext of a sealed copy for its owner, for the gateway to pass to their
// client. The caller closes it. A copy of anyone else's is ErrUnavailable, as is one that
// doesn't exist.
//
// Copies written before owners had directories are in the store's own directory, with no
// record of whose they are. Those are opened for anyone who names one: a media ID is 128
// random bits that only ever appear inside the owner's sealed plaintext, and the file is
// ciphertext under a key that does too, so what it gives away is its size.
func (s *Store) Open(mediaID, ownerUserID string) (*os.File, error) {
	if !validID(mediaID) || ownerUserID == "" {
		return nil, ErrUnavailable
	}
	f, err := openNoFollow(filepath.Join(s.ownerDir(ownerUserID), mediaID))
	if errors.Is(err, os.ErrNotExist) {
		f, err = openNoFollow(s.path(mediaID))
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, ErrUnavailable
	}
	return f, nil
}

// writeNew writes a new file, refusing to follow a symlink or replace anything at path.
func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// readNoFollow reads a file without following a symlink in its place, so nothing else that
// can write to the media directory can point the store at another file.
func readNoFollow(path string) ([]byte, error) {
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// budget is a count of bytes that waiters take a share of and give back.
type budget struct {
	lock  sync.Mutex
	total int64
	free  int64
	freed chan struct{}
}

func newBudget(total int64) *budget {
	return &budget{total: total, free: total, freed: make(chan struct{})}
}

// acquire waits until n bytes are free, or ctx ends. A share larger than the whole budget
// waits for all of it, so one file never goes over by more than itself.
func (b *budget) acquire(ctx context.Context, n int64) (func(), error) {
	n = min(n, b.total)
	for {
		b.lock.Lock()
		if b.free >= n {
			b.free -= n
			b.lock.Unlock()
			var once sync.Once
			return func() { once.Do(func() { b.give(n) }) }, nil
		}
		freed := b.freed
		b.lock.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-freed:
		}
	}
}

func (b *budget) give(n int64) {
	b.lock.Lock()
	b.free += n
	close(b.freed)
	b.freed = make(chan struct{})
	b.lock.Unlock()
}

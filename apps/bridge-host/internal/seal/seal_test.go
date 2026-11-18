package seal

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/blake2b"
)

var testCtx = Context{Kind: KindMessage, OwnerUserID: "user_1", ObjectID: "evt_1"}

func mustKeyPair(t *testing.T) KeyPair {
	t.Helper()
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	return kp
}

func TestRoundTrip(t *testing.T) {
	owner, agent := mustKeyPair(t), mustKeyPair(t)
	env, err := SealJSON(map[string]string{"body": "hi"}, []PublicKey{owner.Public, agent.Public, owner.Public}, testCtx)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Keys) != 2 {
		t.Fatalf("expected duplicate recipient to be listed once, got %d keys", len(env.Keys))
	}
	for _, kp := range []KeyPair{owner, agent} {
		var out map[string]string
		if err = OpenJSON(env, kp, testCtx, &out); err != nil || out["body"] != "hi" {
			t.Fatalf("open failed: %v %v", out, err)
		}
	}
	if _, err = Open(env, mustKeyPair(t), testCtx); !errors.Is(err, ErrNotRecipient) {
		t.Fatalf("expected ErrNotRecipient, got %v", err)
	}
}

func TestBindsToRow(t *testing.T) {
	owner := mustKeyPair(t)
	env, err := Seal([]byte("x"), []PublicKey{owner.Public}, testCtx)
	if err != nil {
		t.Fatal(err)
	}
	for _, ctx := range []Context{
		{Kind: KindMessage, OwnerUserID: "user_1", ObjectID: "evt_2"},
		{Kind: KindMessage, OwnerUserID: "user_2", ObjectID: "evt_1"},
		{Kind: KindChat, OwnerUserID: "user_1", ObjectID: "evt_1"},
	} {
		if _, err = Open(env, owner, ctx); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("expected ErrDecrypt for %+v, got %v", ctx, err)
		}
	}
	if _, err = Seal([]byte("x"), []PublicKey{owner.Public}, Context{Kind: KindMessage}); !errors.Is(err, ErrBadContext) {
		t.Fatalf("expected ErrBadContext, got %v", err)
	}
	if _, err = Seal([]byte("x"), nil, testCtx); !errors.Is(err, ErrNoRecipients) {
		t.Fatalf("expected ErrNoRecipients, got %v", err)
	}
}

func TestRecipients(t *testing.T) {
	owner, agent := mustKeyPair(t), mustKeyPair(t)
	env, _ := Seal([]byte("history"), []PublicKey{owner.Public}, testCtx)
	granted, err := AddRecipient(env, owner, agent.Public, testCtx)
	if err != nil {
		t.Fatal(err)
	}
	if granted.CT != env.CT {
		t.Fatal("adding a recipient must not re-encrypt the content")
	}
	if got, err := Open(granted, agent, testCtx); err != nil || string(got) != "history" {
		t.Fatalf("agent can't open: %v", err)
	}
	if _, err = AddRecipient(env, owner, agent.Public, Context{Kind: KindMessage, OwnerUserID: "user_1", ObjectID: "other"}); err == nil {
		t.Fatal("re-sharing for the wrong row must fail")
	}
	revoked, err := RemoveRecipient(granted, agent.Public.KeyID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Open(revoked, agent, testCtx); !errors.Is(err, ErrNotRecipient) {
		t.Fatalf("revoked agent opened the envelope: %v", err)
	}
	if _, err = RemoveRecipient(revoked, owner.Public.KeyID()); !errors.Is(err, ErrLastRecipient) {
		t.Fatalf("expected ErrLastRecipient, got %v", err)
	}
}

func TestMedia(t *testing.T) {
	media, err := EncryptMedia([]byte("file"), "user_1", "media_1")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := DecryptMedia(media.Ciphertext, media.Key, media.Nonce, "user_1", "media_1"); err != nil || string(got) != "file" {
		t.Fatalf("media round trip failed: %v", err)
	}
	if _, err = DecryptMedia(media.Ciphertext, media.Key, media.Nonce, "user_1", "media_2"); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("expected ErrDecrypt, got %v", err)
	}
}

// vectorFile is the shape of packages/crypto/testdata/vectors.json.
type vectorFile struct {
	Comment    string `json:"comment"`
	Recipients []struct {
		Name       string `json:"name"`
		PublicKey  string `json:"publicKey"`
		PrivateKey string `json:"privateKey"`
		KID        string `json:"kid"`
	} `json:"recipients"`
	Envelopes []struct {
		Name       string          `json:"name"`
		Context    Context         `json:"context"`
		Recipients []string        `json:"recipients"`
		Plaintext  json.RawMessage `json:"plaintext"`
		Envelope   *Envelope       `json:"envelope"`
	} `json:"envelopes"`
	Media []struct {
		OwnerUserID string `json:"ownerUserId"`
		MediaID     string `json:"mediaId"`
		Plaintext   string `json:"plaintext"`
		Ciphertext  string `json:"ciphertext"`
		Key         string `json:"key"`
		Nonce       string `json:"nonce"`
	} `json:"media"`
}

const testdataDir = "../../../../packages/crypto/testdata"

// seededKeyPair derives the same fixed test keys as packages/crypto/scripts/write-vectors.ts.
func seededKeyPair(name string) KeyPair {
	seed := blake2b.Sum256([]byte("trioditis test vector " + name))
	return SeedKeyPair(seed[:])
}

func checkVectors(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var vectors vectorFile
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	keys := make(map[string]KeyPair)
	for _, r := range vectors.Recipients {
		kp, err := ParseKeyPair(r.PublicKey, r.PrivateKey)
		if err != nil {
			t.Fatalf("%s: %v", r.Name, err)
		}
		if kp.Public.KeyID() != r.KID {
			t.Fatalf("%s: key ID %s, vectors say %s", r.Name, kp.Public.KeyID(), r.KID)
		}
		if seeded := seededKeyPair(r.Name); seeded.Public != kp.Public {
			t.Fatalf("%s: seeded key pair doesn't match libsodium's crypto_box_seed_keypair", r.Name)
		}
		keys[r.Name] = kp
	}
	for _, v := range vectors.Envelopes {
		for _, name := range v.Recipients {
			got, err := Open(v.Envelope, keys[name], v.Context)
			if err != nil {
				t.Fatalf("%s for %s: %v", v.Name, name, err)
			}
			var want, have any
			_ = json.Unmarshal(v.Plaintext, &want)
			_ = json.Unmarshal(got, &have)
			wantJSON, _ := json.Marshal(want)
			haveJSON, _ := json.Marshal(have)
			if !bytes.Equal(wantJSON, haveJSON) {
				t.Fatalf("%s: plaintext %s, want %s", v.Name, haveJSON, wantJSON)
			}
		}
	}
	for _, m := range vectors.Media {
		ct, _ := Decode(m.Ciphertext)
		got, err := DecryptMedia(ct, m.Key, m.Nonce, m.OwnerUserID, m.MediaID)
		if err != nil {
			t.Fatal(err)
		}
		if want, _ := Decode(m.Plaintext); !bytes.Equal(got, want) {
			t.Fatal("media plaintext mismatch")
		}
	}
}

func TestOpensTypeScriptVectors(t *testing.T) {
	checkVectors(t, filepath.Join(testdataDir, "vectors.json"))
}

// TestWritesGoVectors writes vectors-go.json, which packages/crypto's tests open, so each
// implementation opens what the other sealed.
func TestWritesGoVectors(t *testing.T) {
	owner, agent, bridge := seededKeyPair("owner"), seededKeyPair("agent-access"), seededKeyPair("bridge")
	message := Context{Kind: KindMessage, OwnerUserID: "user_1", ObjectID: "evt_go"}
	outbound := Context{Kind: KindOutbound, OwnerUserID: "user_1", ObjectID: "cm_go"}
	chat := Context{Kind: KindChat, OwnerUserID: "user_1", ObjectID: "whatsapp:456@g.us"}
	type plain = map[string]any
	msgPlain := plain{"type": "text", "body": "Hello from Go 🦫", "mentions": []string{}}
	outPlain := plain{"type": "text", "body": "Sealed by the bridge host"}
	chatPlain := plain{"name": "Group from Go", "topic": "t"}
	mustSeal := func(v any, to []PublicKey, ctx Context) *Envelope {
		env, err := SealJSON(v, to, ctx)
		if err != nil {
			t.Fatal(err)
		}
		return env
	}
	mediaBytes := []byte("media sealed in Go")
	media, err := EncryptMedia(mediaBytes, "user_1", "media_go")
	if err != nil {
		t.Fatal(err)
	}
	type recipient struct {
		Name       string `json:"name"`
		PublicKey  string `json:"publicKey"`
		PrivateKey string `json:"privateKey"`
		KID        string `json:"kid"`
	}
	rec := func(name string, kp KeyPair) recipient {
		return recipient{name, kp.Public.String(), Encode(kp.Private[:]), kp.Public.KeyID()}
	}
	type envelopeVector struct {
		Name       string    `json:"name"`
		Context    Context   `json:"context"`
		Recipients []string  `json:"recipients"`
		Plaintext  any       `json:"plaintext"`
		Envelope   *Envelope `json:"envelope"`
	}
	out := map[string]any{
		"comment":    "Generated by apps/bridge-host/internal/seal tests (TestWritesGoVectors). See docs/architecture/sealing.md.",
		"recipients": []recipient{rec("owner", owner), rec("agent-access", agent), rec("bridge", bridge)},
		"envelopes": []envelopeVector{
			{"message to owner and agent", message, []string{"owner", "agent-access"}, msgPlain, mustSeal(msgPlain, []PublicKey{owner.Public, agent.Public}, message)},
			{"outbound to bridge", outbound, []string{"bridge"}, outPlain, mustSeal(outPlain, []PublicKey{bridge.Public}, outbound)},
			{"chat metadata to owner", chat, []string{"owner"}, chatPlain, mustSeal(chatPlain, []PublicKey{owner.Public}, chat)},
		},
		"media": []map[string]string{{
			"ownerUserId": "user_1",
			"mediaId":     "media_go",
			"plaintext":   Encode(mediaBytes),
			"ciphertext":  Encode(media.Ciphertext),
			"key":         media.Key,
			"nonce":       media.Nonce,
		}},
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(testdataDir, "vectors-go.json")
	if err = os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	checkVectors(t, path)
}

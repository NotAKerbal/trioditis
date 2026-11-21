package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestRefusedAddressGetsNothing(t *testing.T) {
	srv := &Server{Token: "t", Refuse: func(addr netip.Addr) bool { return addr == netip.MustParseAddr("10.0.0.9") }}
	routes := srv.Routes()
	for remote, want := range map[string]int{"10.0.0.9:5555": http.StatusForbidden, "10.0.0.2:5555": http.StatusOK} {
		req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
		req.RemoteAddr = remote
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("health from %s: %d, want %d", remote, rec.Code, want)
		}
	}
}

type fakeMedia map[string]string // "mediaID/userID" → file path

func (m fakeMedia) Open(mediaID, ownerUserID string) (*os.File, error) {
	path, ok := m[mediaID+"/"+ownerUserID]
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.Open(path)
}

func TestMediaGoesOnlyToItsOwnerThroughTheGateway(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	routes := (&Server{Token: "t", Media: fakeMedia{"m1/alice": path}}).Routes()
	get := func(token, userID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/v1/media/m1", nil)
		req.RemoteAddr = "10.0.0.2:5555"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if userID != "" {
			req.Header.Set("X-Trioditis-User-Id", userID)
		}
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, req)
		return rec
	}
	if rec := get("t", "alice"); rec.Code != http.StatusOK || rec.Body.String() != "ciphertext" ||
		rec.Header().Get("Content-Type") != "application/octet-stream" || rec.Header().Get("Content-Length") != "10" {
		t.Fatalf("alice: %d %q %v", rec.Code, rec.Body.String(), rec.Header())
	}
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"bob":         get("t", "bob"),
		"no person":   get("t", ""),
		"wrong token": get("x", "alice"),
		"no token":    get("", "alice"),
	} {
		if rec.Code == http.StatusOK || rec.Body.String() == "ciphertext" {
			t.Errorf("%s got the file: %d", name, rec.Code)
		}
	}
}

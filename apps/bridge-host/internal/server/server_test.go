package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
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

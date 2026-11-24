package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInternalShutdownRequiresBearerToken(t *testing.T) {
	shutdown := make(chan struct{}, 1)
	handler := withInternalShutdown(http.NotFoundHandler(), "runner-secret", shutdown)

	for _, authorization := range []string{"", "Bearer wrong-secret"} {
		req := httptest.NewRequest(http.MethodPost, "/internal/shutdown", nil)
		req.Header.Set("Authorization", authorization)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("authorization %q: expected 401, got %d", authorization, res.Code)
		}
	}
	if len(shutdown) != 0 {
		t.Fatal("unauthorized request triggered shutdown")
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/shutdown", nil)
	req.Header.Set("Authorization", "Bearer runner-secret")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", res.Code, res.Body.String())
	}
	select {
	case <-shutdown:
	default:
		t.Fatal("authorized request did not schedule shutdown")
	}
}

func TestInternalShutdownOnlyAcceptsPost(t *testing.T) {
	shutdown := make(chan struct{}, 1)
	handler := withInternalShutdown(http.NotFoundHandler(), "runner-secret", shutdown)
	req := httptest.NewRequest(http.MethodGet, "/internal/shutdown", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", res.Code)
	}
	if len(shutdown) != 0 {
		t.Fatal("GET request triggered shutdown")
	}
}

func TestInternalShutdownPassesThroughOtherPaths(t *testing.T) {
	shutdown := make(chan struct{}, 1)
	called := false
	handler := withInternalShutdown(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}), "runner-secret", shutdown)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if !called || res.Code != http.StatusNoContent {
		t.Fatalf("health request was not passed through: called=%v status=%d", called, res.Code)
	}
}

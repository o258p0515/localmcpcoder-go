package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInternalShutdownRequiresBearerAndPOST(t *testing.T) {
	called := make(chan struct{}, 1)
	handler := withInternalShutdown(http.NotFoundHandler(), "unit-test-token-123456", func() { called <- struct{}{} })

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/internal/shutdown", nil))
	if get.Code != http.StatusMethodNotAllowed || len(called) != 0 {
		t.Fatalf("GET should be rejected without shutdown: status=%d called=%v", get.Code, called)
	}

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/internal/shutdown", nil))
	if unauthorized.Code != http.StatusUnauthorized || len(called) != 0 {
		t.Fatalf("missing token should be rejected: status=%d called=%v", unauthorized.Code, called)
	}

	request := httptest.NewRequest(http.MethodPost, "/internal/shutdown", nil)
	request.Header.Set("Authorization", "Bearer unit-test-token-123456")
	accepted := httptest.NewRecorder()
	handler.ServeHTTP(accepted, request)
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("valid request should be accepted: status=%d", accepted.Code)
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("valid request did not invoke shutdown callback")
	}
}

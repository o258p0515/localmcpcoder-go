package main

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// withInternalShutdown exposes a loopback-only shutdown hook for managed Hub
// runners. The handler is mounted only on the 127.0.0.1 listener and requires
// the same bearer token used by the local MCP endpoint.
func withInternalShutdown(next http.Handler, token string, shutdown func()) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		bearer := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
		if token == "" || !strings.HasPrefix(authorization, "Bearer ") || len(bearer) != len(token) || subtle.ConstantTimeCompare([]byte(bearer), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("graceful shutdown requested\n"))
		go shutdown()
	})
	mux.Handle("/", next)
	return mux
}

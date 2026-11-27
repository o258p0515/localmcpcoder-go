package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestWebsocketURLBuildsRunnerMetadata(t *testing.T) {
	c, err := New(Config{
		HubURLs:         "https://hub.example.com",
		Token:           "0123456789abcdef",
		RunnerID:        "test-01",
		RunnerTags:      "linux,go",
		Port:            8787,
		DurationSeconds: 20400,
		PredecessorID:   "test-00",
		Generation:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.websocketURL("https://hub.example.com")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"wss://hub.example.com/internal/runner-ws",
		"id=test-01",
		"os=",
		"arch=",
		"tags=linux%2Cgo%2Cagent",
		"predecessor_id=test-00",
		"generation=2",
		"duration_seconds=20400",
		"handover_after=19800",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q missing %q", got, want)
		}
	}

	cDisabled, err := New(Config{
		HubURLs:         "https://hub.example.com",
		Token:           "0123456789abcdef",
		RunnerID:        "test-02",
		DurationSeconds: 600,
		HandoverAfter:   -1,
		IdleTimeout:     30,
	})
	if err != nil {
		t.Fatal(err)
	}
	gotDisabled, err := cDisabled.websocketURL("https://hub.example.com")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"handover_after=-1", "idle_timeout=30"} {
		if !strings.Contains(gotDisabled, want) {
			t.Fatalf("%q missing %q", gotDisabled, want)
		}
	}
}

func TestNewRequiresHubCredentials(t *testing.T) {
	if _, err := New(Config{HubURLs: "https://hub.example.com"}); err == nil {
		t.Fatal("expected missing MCP token error")
	}
	if _, err := New(Config{Token: "0123456789abcdef"}); err == nil {
		t.Fatal("expected missing URL error")
	}
}

func TestShutdownDrainsActiveRequests(t *testing.T) {
	c, err := New(Config{HubURLs: "https://hub.example.com", Token: "0123456789abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	if !c.beginRequest() {
		t.Fatal("request was unexpectedly rejected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := c.Shutdown(ctx); err == nil {
		t.Fatal("expected deadline while request is active")
	}
	if c.beginRequest() {
		t.Fatal("new request accepted after draining began")
	}
	c.finishRequest()
}

func TestEnsureRoleTagSkipsAgentForGitExecutor(t *testing.T) {
	c, err := New(Config{HubURLs: "https://hub.example.com", Token: "0123456789abcdef", RunnerID: "git-01", RunnerTags: "linux,git,isolated", ToolProfile: "git-executor"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.websocketURL("https://hub.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "agent") {
		t.Fatalf("git-executor runner should not be tagged agent: %q", got)
	}
}

func TestWebSocketShutdownFrameTriggersOnShutdown(t *testing.T) {
	shutdownCh := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusNormalClosure, "")
		msg, _ := json.Marshal(map[string]any{
			"type":         "shutdown",
			"reason":       "handover_complete",
			"successor_id": "runner-g2",
		})
		_ = ws.Write(r.Context(), websocket.MessageText, msg)
		_, _, _ = ws.Read(r.Context())
	}))
	defer srv.Close()

	c, err := New(Config{
		HubURLs:  srv.URL,
		Token:    "0123456789abcdef",
		RunnerID: "runner-g1",
		OnShutdown: func(reason string) {
			select {
			case shutdownCh <- reason:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Run(ctx) }()

	select {
	case reason := <-shutdownCh:
		if reason != "handover_complete" {
			t.Fatalf("expected handover_complete, got %q", reason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for OnShutdown from WebSocket shutdown frame")
	}
}

func TestHandoverTimerSendsHandoverRequestOverWebSocket(t *testing.T) {
	received := make(chan map[string]any, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close(websocket.StatusNormalClosure, "")
		for {
			_, data, err := ws.Read(r.Context())
			if err != nil {
				return
			}
			var msg map[string]any
			if json.Unmarshal(data, &msg) == nil && msg["type"] == "handover_request" {
				received <- msg
			}
		}
	}))
	defer srv.Close()

	c, err := New(Config{
		HubURLs:         srv.URL,
		Token:           "0123456789abcdef",
		RunnerID:        "runner-g1",
		RunnerTags:      "linux,go,pair:p1",
		DurationSeconds: 300,
		HandoverAfter:   1,
		Generation:      1,
		TickInterval:    50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Run(ctx) }()

	select {
	case msg := <-received:
		if msg["runner_id"] != "runner-g1" || msg["reason"] != "quota_expiring" {
			t.Fatalf("unexpected handover_request payload: %#v", msg)
		}
		if int(msg["generation"].(float64)) != 1 {
			t.Fatalf("expected generation=1, got %#v", msg["generation"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for handover_request frame")
	}
}

func TestIdleTimeoutSkipsInFlightRequestsAndExitsWhenIdle(t *testing.T) {
	shutdownCh := make(chan string, 2)
	c, err := New(Config{
		HubURLs:      "https://hub.example.com",
		Token:        "0123456789abcdef",
		RunnerID:     "runner-idle",
		IdleTimeout:  1,
		TickInterval: 50 * time.Millisecond,
		OnShutdown: func(reason string) {
			select {
			case shutdownCh <- reason:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Simulate an active in-flight request: even if startedAt/lastActivity was 5s ago,
	// idle_timeout must NOT trigger while active > 0.
	if !c.beginRequest() {
		t.Fatal("beginRequest failed")
	}
	c.checkLifecycle(time.Now().Add(5 * time.Second))
	select {
	case r := <-shutdownCh:
		t.Fatalf("idle_timeout triggered while request was active: %q", r)
	default:
	}

	// Finish request, then advance time past IdleTimeout.
	c.finishRequest()
	c.checkLifecycle(time.Now().Add(2 * time.Second))
	select {
	case r := <-shutdownCh:
		if r != "idle_timeout" {
			t.Fatalf("expected idle_timeout, got %q", r)
		}
	case <-time.After(time.Second):
		t.Fatal("expected idle_timeout shutdown after request finished")
	}
}

func TestHandoverSkippedWhenRunnerIsIdleAtThreshold(t *testing.T) {
	shutdownCh := make(chan string, 2)
	c, err := New(Config{
		HubURLs:       "https://hub.example.com",
		Token:         "0123456789abcdef",
		RunnerID:      "runner-idle-handover",
		HandoverAfter: 1800,
		IdleTimeout:   0,
		OnShutdown: func(reason string) {
			select {
			case shutdownCh <- reason:
			default:
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now()
	c.startedAt = base
	c.lastActivity = base
	c.checkLifecycle(base.Add(1801 * time.Second))

	select {
	case r := <-shutdownCh:
		if r != "idle_at_handover" {
			t.Fatalf("expected idle_at_handover, got %q", r)
		}
	case <-time.After(time.Second):
		t.Fatal("expected idle_at_handover shutdown instead of spawning successor")
	}
}

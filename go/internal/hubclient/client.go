package hubclient

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	mrand "math/rand"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Config struct {
	HubURLs         string
	Token           string
	RunnerID        string
	RunnerTags      string
	ToolProfile     string
	Port            int
	Repo            string
	DurationSeconds int
	HandoverAfter   int
	IdleTimeout     int
	PredecessorID   string
	Generation      int
	OnShutdown      func(reason string)
	TickInterval    time.Duration
}

type Client struct {
	cfg          Config
	http         *http.Client
	mu           sync.Mutex
	connections  map[*connection]struct{}
	draining     bool
	active       int
	cond         *sync.Cond
	startedAt    time.Time
	lastActivity time.Time
	handoverSent bool
	shutdownOnce sync.Once
}

type connection struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
}

type frame struct {
	Type        string          `json:"type"`
	ReqID       string          `json:"req_id,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Reason      string          `json:"reason,omitempty"`
	SuccessorID string          `json:"successor_id,omitempty"`
}

func New(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.HubURLs) == "" {
		return nil, fmt.Errorf("HUB_URLS/--hub-urls is required")
	}
	if cfg.Token == "" {
		return nil, fmt.Errorf("MCP_TOKEN is required for both Hub authentication and the local MCP handler")
	}
	if cfg.Port == 0 {
		cfg.Port = 8787
	}
	if cfg.RunnerID == "" {
		cfg.RunnerID = defaultRunnerID()
	} else {
		cfg.RunnerID = sanitizeRunnerID(cfg.RunnerID)
	}
	if cfg.Repo == "" {
		cfg.Repo = os.Getenv("GITHUB_REPOSITORY")
	}
	if cfg.HandoverAfter == 0 && cfg.DurationSeconds > 600 {
		cfg.HandoverAfter = cfg.DurationSeconds - 600
	}
	if cfg.Generation <= 0 {
		cfg.Generation = 1
	}
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = time.Second
	}
	cfg.RunnerTags = ensureRoleTag(cfg.RunnerTags, cfg.ToolProfile)
	urls := splitURLs(cfg.HubURLs)
	if len(urls) == 0 {
		return nil, fmt.Errorf("no valid Hub URL configured")
	}
	for _, raw := range urls {
		u, err := url.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid Hub URL %q: %w", raw, err)
		}
		if u.Host == "" || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "wss" && u.Scheme != "ws") {
			return nil, fmt.Errorf("Hub URL must use http(s) or ws(s) and include a hostname: %q", raw)
		}
	}
	now := time.Now()
	c := &Client{
		cfg:          cfg,
		http:         &http.Client{Timeout: 24 * time.Hour},
		connections:  make(map[*connection]struct{}),
		startedAt:    now,
		lastActivity: now,
	}
	c.cond = sync.NewCond(&c.mu)
	return c, nil
}

func (c *Client) RunnerID() string { return c.cfg.RunnerID }

func (c *Client) Run(ctx context.Context) error {
	urls := splitURLs(c.cfg.HubURLs)
	var wg sync.WaitGroup
	if c.cfg.HandoverAfter > 0 || c.cfg.IdleTimeout > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.lifecycleLoop(ctx)
		}()
	}
	for _, raw := range urls {
		raw := raw
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.runHub(ctx, raw)
		}()
	}
	<-ctx.Done()
	wg.Wait()
	return ctx.Err()
}

func (c *Client) lifecycleLoop(ctx context.Context) {
	ticker := time.NewTicker(c.cfg.TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			c.checkLifecycle(now)
		}
	}
}

func (c *Client) checkLifecycle(now time.Time) {
	var sendHandover bool
	var handoverPayload []byte
	var shutdownReason string

	c.mu.Lock()
	if c.draining {
		c.mu.Unlock()
		return
	}
	if c.cfg.IdleTimeout > 0 && c.active == 0 && now.Sub(c.lastActivity) >= time.Duration(c.cfg.IdleTimeout)*time.Second {
		shutdownReason = "idle_timeout"
	} else if c.cfg.HandoverAfter > 0 && !c.handoverSent && now.Sub(c.startedAt) >= time.Duration(c.cfg.HandoverAfter)*time.Second {
		c.handoverSent = true
		idleDur := now.Sub(c.lastActivity)
		skipForIdle := c.active == 0 && c.cfg.IdleTimeout > 0 && idleDur >= time.Duration(c.cfg.IdleTimeout)*time.Second
		if skipForIdle {
			shutdownReason = "idle_at_handover"
		} else {
			remaining := 0
			if c.cfg.DurationSeconds > 0 {
				if rem := c.cfg.DurationSeconds - int(now.Sub(c.startedAt).Seconds()); rem > 0 {
					remaining = rem
				}
			}
			sendHandover = true
			handoverPayload, _ = json.Marshal(map[string]any{
				"type":              "handover_request",
				"runner_id":         c.cfg.RunnerID,
				"reason":            "quota_expiring",
				"remaining_seconds": remaining,
				"active_requests":   c.active,
				"idle_seconds":      int(idleDur.Seconds()),
				"generation":        c.cfg.Generation,
				"tags":              splitTags(c.cfg.RunnerTags),
				"os":                runtime.GOOS,
				"arch":              runtime.GOARCH,
				"repo":              c.cfg.Repo,
			})
		}
	}
	c.mu.Unlock()

	if shutdownReason != "" {
		c.requestShutdown(shutdownReason)
		return
	}
	if sendHandover && len(handoverPayload) > 0 {
		c.broadcast(handoverPayload)
	}
}

func (c *Client) broadcast(data []byte) {
	c.mu.Lock()
	conns := make([]*connection, 0, len(c.connections))
	for conn := range c.connections {
		conns = append(conns, conn)
	}
	c.mu.Unlock()
	for _, conn := range conns {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = conn.write(ctx, data)
		cancel()
	}
}

func (c *Client) requestShutdown(reason string) {
	c.shutdownOnce.Do(func() {
		if c.cfg.OnShutdown != nil {
			go c.cfg.OnShutdown(reason)
		}
	})
}

func (c *Client) runHub(ctx context.Context, raw string) {
	backoff := time.Second
	for ctx.Err() == nil {
		target, err := c.websocketURL(raw)
		if err != nil {
			return
		}
		headers := http.Header{}
		headers.Set("Authorization", "Bearer "+c.cfg.Token)
		dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		ws, _, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{HTTPHeader: headers})
		cancel()
		if err != nil {
			fmt.Printf("Hub connection to %s failed: %v; retrying\n", raw, err)
			if !sleepContext(ctx, jitter(backoff)) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		conn := &connection{ws: ws}
		c.mu.Lock()
		if c.draining {
			c.mu.Unlock()
			_ = ws.Close(websocket.StatusNormalClosure, "runner draining")
			return
		}
		c.connections[conn] = struct{}{}
		c.mu.Unlock()
		fmt.Printf("Connected LocalMCP runner %s to Hub %s\n", c.cfg.RunnerID, raw)
		backoff = time.Second
		c.readLoop(ctx, conn)
		c.mu.Lock()
		delete(c.connections, conn)
		draining := c.draining
		c.mu.Unlock()
		if draining || ctx.Err() != nil {
			return
		}
		_ = ws.Close(websocket.StatusGoingAway, "reconnecting")
		fmt.Printf("Hub connection to %s closed; reconnecting\n", raw)
		if !sleepContext(ctx, jitter(backoff)) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

func (c *Client) readLoop(ctx context.Context, conn *connection) {
	ping := time.NewTicker(45 * time.Second)
	defer ping.Stop()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, data, err := conn.ws.Read(ctx)
			if err != nil {
				return
			}
			if string(data) == "pong" {
				continue
			}
			var incoming frame
			if json.Unmarshal(data, &incoming) != nil {
				continue
			}
			switch incoming.Type {
			case "rpc_request":
				if !c.beginRequest() {
					continue
				}
				go func(f frame) {
					defer c.finishRequest()
					c.dispatch(ctx, conn, f)
				}(incoming)
			case "shutdown":
				c.mu.Lock()
				c.draining = true
				c.mu.Unlock()
				reason := strings.TrimSpace(incoming.Reason)
				if reason == "" {
					reason = "hub_shutdown"
				}
				c.requestShutdown(reason)
				// Keep the WebSocket open so in-flight RPC responses can still
				// be delivered while Shutdown() drains active requests.
			case "ping":
				writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = conn.write(writeCtx, []byte("pong"))
				cancel()
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-readDone:
			return
		case <-ping.C:
			if err := conn.write(ctx, []byte("ping")); err != nil {
				return
			}
		}
	}
}

func (c *Client) dispatch(ctx context.Context, conn *connection, incoming frame) {
	var payload map[string]any
	if err := json.Unmarshal(incoming.Payload, &payload); err != nil {
		c.sendResponse(conn, incoming.ReqID, map[string]any{"jsonrpc": "2.0", "id": incoming.ReqID, "error": map[string]any{"code": -32600, "message": "invalid Hub RPC payload"}})
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		c.sendResponse(conn, incoming.ReqID, map[string]any{"jsonrpc": "2.0", "id": incoming.ReqID, "error": map[string]any{"code": -32603, "message": err.Error()}})
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/mcp", c.cfg.Port), strings.NewReader(string(body)))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		c.sendResponse(conn, incoming.ReqID, map[string]any{"jsonrpc": "2.0", "id": incoming.ReqID, "error": map[string]any{"code": -32000, "message": err.Error()}})
		return
	}
	defer resp.Body.Close()
	result, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if readErr != nil {
		c.sendResponse(conn, incoming.ReqID, map[string]any{"jsonrpc": "2.0", "id": incoming.ReqID, "error": map[string]any{"code": -32603, "message": readErr.Error()}})
		return
	}
	var response any
	if json.Unmarshal(result, &response) != nil {
		response = map[string]any{"jsonrpc": "2.0", "id": incoming.ReqID, "error": map[string]any{"code": -32603, "message": fmt.Sprintf("local MCP returned HTTP %d and invalid JSON", resp.StatusCode)}}
	}
	c.sendResponse(conn, incoming.ReqID, response)
}

func (c *Client) sendResponse(conn *connection, reqID string, payload any) {
	b, err := json.Marshal(map[string]any{"type": "rpc_response", "req_id": reqID, "payload": payload})
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = conn.write(ctx, b)
		cancel()
	}
}

func (c *Client) beginRequest() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.draining {
		return false
	}
	c.active++
	c.lastActivity = time.Now()
	return true
}

func (c *Client) finishRequest() {
	c.mu.Lock()
	c.active--
	c.lastActivity = time.Now()
	c.cond.Broadcast()
	c.mu.Unlock()
}

func (c *Client) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	c.draining = true
	conns := make([]*connection, 0, len(c.connections))
	for conn := range c.connections {
		conns = append(conns, conn)
	}
	c.mu.Unlock()
	msg, _ := json.Marshal(map[string]any{"type": "status_update", "status": "draining"})
	for _, conn := range conns {
		_ = conn.write(ctx, msg)
	}
	done := make(chan struct{})
	go func() {
		c.mu.Lock()
		for c.active > 0 {
			c.cond.Wait()
		}
		c.mu.Unlock()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		for _, conn := range conns {
			_ = conn.ws.Close(websocket.StatusGoingAway, "drain deadline reached")
		}
		return ctx.Err()
	}
	for _, conn := range conns {
		_ = conn.ws.Close(websocket.StatusNormalClosure, "runner drained")
	}
	return nil
}

func (conn *connection) write(ctx context.Context, data []byte) error {
	conn.writeMu.Lock()
	defer conn.writeMu.Unlock()
	return conn.ws.Write(ctx, websocket.MessageText, data)
}

func (c *Client) websocketURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
	default:
		return "", fmt.Errorf("unsupported Hub URL scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/internal/runner-ws"
	q := u.Query()
	q.Set("id", c.cfg.RunnerID)
	q.Set("os", runtime.GOOS)
	q.Set("arch", runtime.GOARCH)
	q.Set("repo", c.cfg.Repo)
	q.Set("tags", c.cfg.RunnerTags)
	if c.cfg.PredecessorID != "" {
		q.Set("predecessor_id", sanitizeRunnerID(c.cfg.PredecessorID))
	}
	if c.cfg.Generation > 0 {
		q.Set("generation", strconv.Itoa(c.cfg.Generation))
	}
	if c.cfg.DurationSeconds > 0 {
		q.Set("duration_seconds", strconv.Itoa(c.cfg.DurationSeconds))
	}
	if c.cfg.HandoverAfter != 0 {
		q.Set("handover_after", strconv.Itoa(c.cfg.HandoverAfter))
	}
	if c.cfg.IdleTimeout > 0 {
		q.Set("idle_timeout", strconv.Itoa(c.cfg.IdleTimeout))
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func splitURLs(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if strings.TrimSpace(part) != "" {
			out = append(out, strings.TrimSpace(part))
		}
	}
	return out
}

func splitTags(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		if t := strings.TrimSpace(part); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func sanitizeRunnerID(value string) string {
	value = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == ':' || r == '-' {
			return r
		}
		return '-'
	}, strings.TrimSpace(value))
	value = strings.Trim(value, ".-_:")
	if len(value) > 128 {
		value = value[:128]
	}
	if value == "" {
		return defaultRunnerID()
	}
	return value
}

func defaultRunnerID() string {
	host, _ := os.Hostname()
	host = strings.ToLower(strings.TrimSpace(host))
	host = sanitizeHost(host)
	b := make([]byte, 4)
	if _, err := crand.Read(b); err != nil {
		return fmt.Sprintf("%s-%d", host, time.Now().Unix())
	}
	return host + "-" + hex.EncodeToString(b)
}

func sanitizeHost(host string) string { return strings.Trim(host, "-.") }

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > 30*time.Second {
		return 30 * time.Second
	}
	return d
}

func jitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.8 + mrand.Float64()*0.4))
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func ensureRoleTag(tags, profile string) string {
	var out []string
	seen := map[string]bool{}
	hasGit := false
	for _, part := range strings.Split(tags, ",") {
		t := strings.TrimSpace(part)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		if t == "git" {
			hasGit = true
		}
		out = append(out, t)
	}
	if profile != "git-executor" && !hasGit && !seen["agent"] {
		out = append(out, "agent")
	}
	return strings.Join(out, ",")
}

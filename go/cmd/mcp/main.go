package main

import (
	"context"
	"crypto/subtle"
	"fmt"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"github.com/o258p0515/localmcpcoder-go/go/internal/hubclient"
	"github.com/o258p0515/localmcpcoder-go/go/internal/server"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tools"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tunnel"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	resolver, err := fsx.New(cfg.Root, cfg.AllowOutsideRoot)
	if err != nil {
		log.Fatal(err)
	}
	sk, err := skills.Load(cfg.Root, cfg.SkillsDir)
	if err != nil {
		log.Fatal(err)
	}
	reg := tools.New(tools.Deps{Config: cfg, Logger: log.Default(), FS: resolver, Root: cfg.Root, Shell: cfg.Shell, MaxOutput: cfg.MaxOutput, Skills: sk, SkillsDir: cfg.SkillsDir})
	srv := server.New(cfg, reg, sk)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	shutdownRequested := make(chan struct{}, 1)
	handler := withInternalShutdown(srv.Handler(), cfg.ShutdownToken, shutdownRequested)
	httpSrv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		select {
		case <-shutdownRequested:
			stop()
		case <-ctx.Done():
		}
	}()
	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	if err = waitLocal(ctx, addr); err != nil {
		_ = httpSrv.Close()
		log.Fatal(err)
	}

	mode := cfg.Tunnel
	if mode == "hub" || cfg.HubURLs != "" {
		var stopTailscale func() error
		if os.Getenv("TS_TRUST_CREDS") != "" || os.Getenv("TS_AUTHKEY") != "" {
			tsPublic, tsStop, tsErr := (tunnel.Tailscale{}).Start(ctx, tunnel.Config{Port: cfg.Port, TSHostname: cfg.TSHostname, TSMode: "up", TSTag: cfg.TSTag}, addr)
			if tsErr != nil {
				_ = httpSrv.Close()
				log.Fatalf("Tailscale setup failed: %v", tsErr)
			}
			stopTailscale = tsStop
			log.Printf("Tailscale node joined; private endpoint: %s", tsPublic)
		}
		hub, e := hubclient.New(hubclient.Config{
			HubURLs:         cfg.HubURLs,
			Token:           cfg.Token,
			RunnerID:        cfg.RunnerID,
			RunnerTags:      cfg.RunnerTags,
			ToolProfile:     cfg.ToolProfile,
			Port:            cfg.Port,
			DurationSeconds: cfg.DurationSeconds,
			HandoverAfter:   cfg.HandoverAfter,
			IdleTimeout:     cfg.IdleTimeout,
			PredecessorID:   cfg.PredecessorID,
			Generation:      cfg.Generation,
			OnShutdown: func(reason string) {
				log.Printf("Hub runner shutdown requested (%s); draining active requests...", reason)
				stop()
			},
		})
		if e != nil {
			if stopTailscale != nil {
				_ = stopTailscale()
			}
			_ = httpSrv.Close()
			log.Fatal(e)
		}
		hubCtx, cancelHub := context.WithCancel(context.Background())
		hubDone := make(chan error, 1)
		go func() { hubDone <- hub.Run(hubCtx) }()
		log.Printf("localmcpcoder-go %s Hub runner %s (gen=%d) started; hubs=%s; local handler=%s (no cloudflared)", version, hub.RunnerID(), cfg.Generation, cfg.HubURLs, addr)
		select {
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if e := hub.Shutdown(shutdown); e != nil {
				log.Printf("Hub graceful drain: %v", e)
			}
			cancel()
		case e := <-errCh:
			if e != nil && e != http.ErrServerClosed {
				log.Printf("HTTP server stopped: %v", e)
			}
			shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_ = hub.Shutdown(shutdown)
			cancel()
		case e := <-hubDone:
			if e != nil && e != context.Canceled {
				log.Printf("Hub client stopped: %v", e)
			}
		}
		cancelHub()
		select {
		case <-hubDone:
		case <-time.After(2 * time.Second):
		}
		if stopTailscale != nil {
			if te := stopTailscale(); te != nil {
				log.Printf("stop Tailscale: %v", te)
			}
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown)
		return
	}

	if mode == "auto" {
		if os.Getenv("CF_API_TOKEN") != "" || os.Getenv("TUNNEL_TOKEN") != "" {
			mode = "cloudflare"
		} else if os.Getenv("TS_AUTHKEY") != "" || os.Getenv("TS_TRUST_CREDS") != "" {
			mode = "tailscale"
		} else {
			mode = "none"
		}
	}
	p, e := tunnel.Select(mode)
	if e != nil {
		log.Fatal(e)
	}
	public, stopTunnel, e := p.Start(ctx, tunnel.Config{Host: cfg.Host, Port: cfg.Port, Provider: mode, TSHostname: cfg.TSHostname, TSMode: cfg.TSMode, TSTag: cfg.TSTag}, addr)
	if e != nil {
		_ = httpSrv.Close()
		log.Fatal(e)
	}
	var stopTailscale func() error
	if mode != "tailscale" && os.Getenv("TS_TRUST_CREDS") != "" {
		tsPublic, tsStop, tsErr := (tunnel.Tailscale{}).Start(ctx, tunnel.Config{Port: cfg.Port, TSHostname: cfg.TSHostname, TSMode: "up", TSTag: cfg.TSTag}, addr)
		if tsErr != nil {
			if stopTunnel != nil {
				_ = stopTunnel()
			}
			_ = httpSrv.Close()
			log.Fatalf("Tailscale setup failed: %v", tsErr)
		}
		stopTailscale = tsStop
		log.Printf("Tailscale node joined; private endpoint: %s", tsPublic)
	}
	if public != "" {
		log.Printf("localmcpcoder-go %s ready: %s/mcp (root %s; tunnel=%s)", version, public, cfg.Root, mode)
	} else {
		log.Printf("localmcpcoder-go %s listening on %s (tunnel=%s; use the hostname configured on that tunnel)", version, addr, mode)
	}
	if os.Getenv("GITHUB_ACTIONS") != "true" && isTTY() {
		log.Printf("MCP passphrase: %s", cfg.Token)
	}
	select {
	case <-ctx.Done():
	case e = <-errCh:
		if e != nil && e != http.ErrServerClosed {
			log.Printf("HTTP server stopped: %v", e)
		}
	}
	if stopTailscale != nil {
		if te := stopTailscale(); te != nil {
			log.Printf("stop Tailscale: %v", te)
		}
	}
	if stopTunnel != nil {
		if te := stopTunnel(); te != nil {
			log.Printf("stop tunnel: %v", te)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdown)
}

// withInternalShutdown exposes a loopback-only, token-protected graceful shutdown
// hook for hosted runners. It never returns or logs the bearer token.
func withInternalShutdown(next http.Handler, token string, shutdown chan<- struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/shutdown" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		bearer := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
		if token == "" || subtle.ConstantTimeCompare([]byte(bearer), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		select {
		case shutdown <- struct{}{}:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, "{\"status\":\"shutting_down\"}\n")
	})
}

func waitLocal(ctx context.Context, addr string) error {
	client := http.Client{Timeout: time.Second}
	for i := 0; i < 50; i++ {
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+addr+"/health", nil)
		r, e := client.Do(req)
		if e == nil {
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			if r.StatusCode == 200 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("MCP server did not start on %s", addr)
}

func isTTY() bool {
	fi, e := os.Stdout.Stat()
	return e == nil && fi.Mode()&os.ModeCharDevice != 0
}

package main

import (
	"context"
	"fmt"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"github.com/o258p0515/localmcpcoder-go/go/internal/server"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tools"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tunnel"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	cfg, e := config.Load()
	if e != nil { log.Fatal(e) }
	resolver, e := fsx.New(cfg.Root, cfg.AllowOutsideRoot)
	if e != nil { log.Fatal(e) }
	sk, e := skills.Load(cfg.Root, cfg.SkillsDir)
	if e != nil { log.Fatal(e) }
	reg := tools.New(tools.Deps{Config: cfg, Logger: log.Default(), FS: resolver, Root: cfg.Root, Shell: cfg.Shell, MaxOutput: cfg.MaxOutput, Skills: sk, SkillsDir: cfg.SkillsDir})
	srv := server.New(cfg, reg, sk)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	if e = waitLocal(ctx, addr); e != nil { _ = httpSrv.Close(); log.Fatal(e) }
	mode := cfg.Tunnel
	if mode == "auto" {
		if os.Getenv("CF_API_TOKEN") != "" || os.Getenv("TUNNEL_TOKEN") != "" { mode = "cloudflare" } else if os.Getenv("TS_AUTHKEY") != "" || os.Getenv("TS_TRUST_CREDS") != "" { mode = "tailscale" } else { mode = "none" }
	}
	p, e := tunnel.Select(mode)
	if e != nil { log.Fatal(e) }
	public, stopTunnel, e := p.Start(ctx, tunnel.Config{Host: cfg.Host, Port: cfg.Port, Provider: mode, TSHostname: cfg.TSHostname, TSMode: cfg.TSMode, TSTag: cfg.TSTag}, addr)
	if e != nil { _ = httpSrv.Close(); log.Fatal(e) }
	var stopTailscale func() error
	// Keep Cloudflare as the public endpoint while also joining the machine to
	// the private tailnet. Trust Credential exchange happens inside this Go process.
	if mode != "tailscale" && os.Getenv("TS_TRUST_CREDS") != "" {
		tsPublic, tsStop, tsErr := (tunnel.Tailscale{}).Start(ctx, tunnel.Config{Port: cfg.Port, TSHostname: cfg.TSHostname, TSMode: "serve", TSTag: cfg.TSTag}, addr)
		if tsErr != nil { if stopTunnel != nil { _ = stopTunnel() }; _ = httpSrv.Close(); log.Fatalf("Tailscale setup failed: %v", tsErr) }
		stopTailscale = tsStop
		log.Printf("Tailscale node joined; private endpoint: %s", tsPublic)
	}
	if public != "" { log.Printf("localmcpcoder-go %s ready: %s/mcp (root %s; tunnel=%s)", version, public, cfg.Root, mode) } else { log.Printf("localmcpcoder-go %s listening on %s (tunnel=%s; use the hostname configured on that tunnel)", version, addr, mode) }
	if os.Getenv("GITHUB_ACTIONS") != "true" && isTTY() { log.Printf("MCP passphrase: %s", cfg.Token) }
	select {
	case <-ctx.Done():
	case e = <-errCh:
		if e != nil && e != http.ErrServerClosed { log.Printf("HTTP server stopped: %v", e) }
	}
	if stopTailscale != nil { if te := stopTailscale(); te != nil { log.Printf("stop Tailscale: %v", te) } }
	if stopTunnel != nil { if te := stopTunnel(); te != nil { log.Printf("stop tunnel: %v", te) } }
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdown)
}
func waitLocal(ctx context.Context, addr string) error {
	client := http.Client{Timeout: time.Second}
	for i := 0; i < 50; i++ {
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://"+addr+"/health", nil)
		r, e := client.Do(req)
		if e == nil { io.Copy(io.Discard, r.Body); r.Body.Close(); if r.StatusCode == 200 { return nil } }
		select { case <-ctx.Done(): return ctx.Err(); case <-time.After(100 * time.Millisecond): }
	}
	return fmt.Errorf("MCP server did not start on %s", addr)
}
func isTTY() bool { fi, e := os.Stdout.Stat(); return e == nil && fi.Mode()&os.ModeCharDevice != 0 }

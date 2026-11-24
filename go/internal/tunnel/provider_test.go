package tunnel

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)
func TestTailscaleUsesExistingCLIAndResetsServe(t *testing.T){if runtime.GOOS=="windows"{t.Skip("uses a POSIX shell fake executable")};d:=t.TempDir();logPath:=filepath.Join(d,"calls");script:=filepath.Join(d,"tailscale");body:=fmt.Sprintf(`#!/bin/sh
echo "$@" >> '%s'
if [ "$1" = serve ] && [ "$2" = --help ]; then echo --bg; fi
if [ "$1" = status ] && [ "$2" = --json ]; then echo '{"Self":{"DNSName":"mcp.tailnet.ts.net."}}'; fi
`,logPath);if e:=os.WriteFile(script,[]byte(body),0755);e!=nil{t.Fatal(e)};t.Setenv("TAILSCALE_BIN",script);u,stop,e:=(Tailscale{}).Start(context.Background(),Config{Port:8787,TSMode:"serve"},"127.0.0.1:8787");if e!=nil{t.Fatal(e)};if u!="https://mcp.tailnet.ts.net"{t.Fatalf("unexpected url %s",u)};if e=stop();e!=nil{t.Fatal(e)};b,_:=os.ReadFile(logPath);if !strings.Contains(string(b),"serve --bg 8787")||!strings.Contains(string(b),"serve reset"){t.Fatalf("unexpected CLI calls: %s",b)}}
func TestTailscaleStartsEphemeralUserspaceDaemonWhenNeeded(t *testing.T){if runtime.GOOS!="linux"{t.Skip("static daemon bootstrap is Linux-only")};d:=t.TempDir();calls:=filepath.Join(d,"cli-calls");state:=filepath.Join(d,"authenticated");daemonArgs:=filepath.Join(d,"daemon-args");cli:=filepath.Join(d,"tailscale");cliScript:=`#!/bin/sh
socket=""
if [ "${1#--socket=}" != "$1" ]; then socket="${1#--socket=}"; shift; fi
echo "$*" >> '`+calls+`'
if [ "$1" = status ] && [ ! -S "$socket" ] && [ ! -f "$socket" ]; then exit 1; fi
if [ "$1" = up ]; then touch '`+state+`'; fi
if [ "$1" = status ] && [ "$2" = --json ]; then if [ -f '`+state+`' ]; then echo '{"Self":{"DNSName":"ephemeral.tailnet.ts.net."}}'; else echo '{"Self":{}}'; fi; fi
if [ "$1" = serve ] && [ "$2" = --help ]; then echo --bg; fi
exit 0
`;if e:=os.WriteFile(cli,[]byte(cliScript),0755);e!=nil{t.Fatal(e)};daemon:=filepath.Join(d,"tailscaled");daemonScript:=`#!/bin/sh
echo "$@" > '`+daemonArgs+`'
for arg in "$@"; do case "$arg" in --socket=*) touch "${arg#--socket=}";; esac; done
exec sleep 60
`;if e:=os.WriteFile(daemon,[]byte(daemonScript),0755);e!=nil{t.Fatal(e)};t.Setenv("TAILSCALE_BIN",cli);t.Setenv("TAILSCALED_BIN",daemon);t.Setenv("TS_AUTHKEY","test-auth-key");u,stop,e:=(Tailscale{}).Start(context.Background(),Config{Port:8787,TSMode:"serve",TSHostname:"test-host"},"127.0.0.1:8787");if e!=nil{t.Fatal(e)};if u!="https://ephemeral.tailnet.ts.net"{t.Fatalf("unexpected url %s",u)};if e=stop();e!=nil{t.Fatal(e)};cb,_:=os.ReadFile(calls);if !strings.Contains(string(cb),"up --auth-key=test-auth-key --hostname=test-host")||!strings.Contains(string(cb),"serve --bg 8787")||!strings.Contains(string(cb),"serve reset")||!strings.Contains(string(cb),"logout"){t.Fatalf("missing daemon-backed CLI calls: %s",cb)};db,_:=os.ReadFile(daemonArgs);for _,arg:=range []string{"--tun=userspace-networking","--state=mem:","--socket="}{if !strings.Contains(string(db),arg){t.Fatalf("missing %s in daemon args: %s",arg,db)}}}

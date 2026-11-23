package tools

import (
 "strings"
 "testing"
 "os"
 "os/exec"
)

func TestScrubEnvRemovesTunnelAndProxyCredentials(t *testing.T) {
 input:=[]string{
  "PATH=/usr/bin", "TS_TRUST_CREDS=tskey-client-id-secret", "TS_AUTHKEY=tskey-auth-secret",
  "MCP_TOKEN=mcp-secret", "CF_API_TOKEN=cloudflare-token", "CF_API_KEY=cloudflare-global-key",
  "TUNNEL_TOKEN=cloudflare-tunnel-token", "HUB_SHARED_SECRET=hub-secret", "ADMIN_TOKEN=admin-secret",
  "MCP_OAUTH_CLIENT_SECRET=oauth-secret", "LANG=C",
 }
 got:=scrubEnv(input)
 for _,entry:=range got {
  key:=strings.SplitN(entry,"=",2)[0]
  switch key {
  case "TS_TRUST_CREDS","TS_AUTHKEY","MCP_TOKEN","CF_API_TOKEN","CF_API_KEY","TUNNEL_TOKEN","HUB_SHARED_SECRET","ADMIN_TOKEN","MCP_OAUTH_CLIENT_SECRET":
   t.Fatalf("secret environment variable %q was passed to child process",key)
  }
 }
 if len(got)!=2 || got[0]!="PATH=/usr/bin" || got[1]!="LANG=C" { t.Fatalf("unexpected preserved environment: %#v",got) }
}

func TestChildProcessCannotReadHubCredentials(t *testing.T) {
	if os.Getenv("LOCALMCP_SECRET_CHILD") == "1" {
		for _, key := range []string{"HUB_SHARED_SECRET", "ADMIN_TOKEN"} {
			if os.Getenv(key) != "" {
				t.Errorf("child process unexpectedly inherited %s", key)
			}
		}
		return
	}
	input := append(os.Environ(),
		"HUB_SHARED_SECRET=hub-secret-sentinel",
		"ADMIN_TOKEN=admin-secret-sentinel",
		"LOCALMCP_SECRET_CHILD=1",
	)
	cmd := exec.Command(os.Args[0], "-test.run=^TestChildProcessCannotReadHubCredentials$")
	cmd.Env = scrubEnv(input)
	cmd.Env = append(cmd.Env, "LOCALMCP_SECRET_CHILD=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child process environment test failed: %v\n%s", err, output)
	}
}

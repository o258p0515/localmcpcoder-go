package tools

import (
 "strings"
 "testing"
)

func TestScrubEnvRemovesTunnelAndProxyCredentials(t *testing.T) {
 input:=[]string{
  "PATH=/usr/bin",
  "TS_TRUST_CREDS=tskey-client-id-secret",
  "TS_AUTHKEY=tskey-auth-secret",
  "MCP_TOKEN=mcp-secret",
  "CF_API_TOKEN=cloudflare-token",
  "CF_API_KEY=cloudflare-global-key",
  "TUNNEL_TOKEN=cloudflare-tunnel-token",
  "LANG=C",
 }
 got:=scrubEnv(input)
 for _,entry:=range got {
  key:=strings.SplitN(entry,"=",2)[0]
  switch key {
  case "TS_TRUST_CREDS","TS_AUTHKEY","MCP_TOKEN","CF_API_TOKEN","CF_API_KEY","TUNNEL_TOKEN":
   t.Fatalf("secret environment variable %q was passed to child process",key)
  }
 }
 if len(got)!=2 || got[0]!="PATH=/usr/bin" || got[1]!="LANG=C" {
  t.Fatalf("unexpected preserved environment: %#v",got)
 }
}

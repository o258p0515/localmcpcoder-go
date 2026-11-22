package tunnel

import (
 "strings"
 "testing"
)

func TestScrubRemovesAllTunnelCredentials(t *testing.T) {
 input:=[]string{
  "PATH=/usr/bin",
  "CF_API_TOKEN=cloudflare-api-token",
  "CF_API_KEY=cloudflare-global-key",
  "TS_AUTHKEY=tskey-auth-secret",
  "TS_TRUST_CREDS=tskey-client-id-secret",
  "MCP_TOKEN=mcp-secret",
  "TUNNEL_TOKEN=cloudflare-tunnel-token",
  "LANG=C",
 }
 got:=scrub(input)
 for _,entry:=range got {
  key:=strings.SplitN(entry,"=",2)[0]
  switch key {
  case "CF_API_TOKEN","CF_API_KEY","TS_AUTHKEY","TS_TRUST_CREDS","MCP_TOKEN","TUNNEL_TOKEN":
   t.Fatalf("secret environment variable %q was passed to child process",key)
  }
 }
 if len(got)!=2 || got[0]!="PATH=/usr/bin" || got[1]!="LANG=C" {
  t.Fatalf("unexpected preserved environment: %#v",got)
 }
}

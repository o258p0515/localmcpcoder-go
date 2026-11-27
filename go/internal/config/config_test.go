package config

import (
 "flag"
 "io"
 "os"
 "path/filepath"
 "strings"
 "testing"
)
func TestTokenFromEnvFile(t *testing.T){p:=filepath.Join(t.TempDir(),".env");if e:=os.WriteFile(p,[]byte("OTHER=x\nMCP_TOKEN=0123456789abcdef\n"),0600);e!=nil{t.Fatal(e)};if got:=tokenFromEnvFile(p);got!="0123456789abcdef"{t.Fatalf("got %q",got)}}
func withArgs(t *testing.T,args ...string){t.Helper();oldArgs:=os.Args;oldFlags:=flag.CommandLine;os.Args=append([]string{"mcp"},args...);flag.CommandLine=flag.NewFlagSet("mcp",flag.ContinueOnError);flag.CommandLine.SetOutput(io.Discard);t.Cleanup(func(){os.Args=oldArgs;flag.CommandLine=oldFlags})}
func TestLoadGeneratesPersistentTokenOutsideCI(t *testing.T){root:=t.TempDir();t.Setenv("MCP_TOKEN","");t.Setenv("GITHUB_ACTIONS","");withArgs(t,"--root",root,"--tunnel","none");c,e:=Load();if e!=nil{t.Fatal(e)};if len(c.Token)!=48{t.Fatalf("unexpected generated token length %d",len(c.Token))};b,e:=os.ReadFile(filepath.Join(root,".env"));if e!=nil{t.Fatal(e)};if !strings.Contains(string(b),c.Token){t.Fatal("generated token was not persisted")};fi,_:=os.Stat(filepath.Join(root,".env"));if fi.Mode().Perm()!=0600{t.Fatalf("unsafe .env permissions: %o",fi.Mode().Perm())}}
func TestLoadRefusesToGenerateTokenInCI(t *testing.T){root:=t.TempDir();t.Setenv("MCP_TOKEN","");t.Setenv("GITHUB_ACTIONS","true");withArgs(t,"--root",root,"--tunnel","none");if _,e:=Load();e==nil||!strings.Contains(e.Error(),"MCP_TOKEN is required"){t.Fatalf("expected CI token error, got %v",e)}}
func TestLoadHubModeRequiresAndAcceptsHubCredentials(t *testing.T){
 root:=t.TempDir();t.Setenv("MCP_TOKEN","0123456789abcdef0123456789abcdef");t.Setenv("GITHUB_ACTIONS","");t.Setenv("HUB_URLS","https://hub.example.com");
 withArgs(t,"--root",root,"--tunnel","hub")
 c,err:=Load();if err!=nil{t.Fatal(err)}
 if c.Tunnel!="hub"||c.HubURLs!="https://hub.example.com"{t.Fatalf("unexpected Hub config: %#v",c)}
}
func TestLoadHubModeUsesMCPTokenWithoutHubSecret(t *testing.T){
 root:=t.TempDir();t.Setenv("MCP_TOKEN","0123456789abcdef0123456789abcdef");t.Setenv("GITHUB_ACTIONS","");t.Setenv("HUB_URLS","https://hub.example.com");t.Setenv("HUB_SHARED_SECRET","")
 withArgs(t,"--root",root,"--tunnel","hub")
 c,err:=Load();if err!=nil{t.Fatal(err)};if c.Token!="0123456789abcdef0123456789abcdef"{t.Fatalf("MCP_TOKEN not loaded")}
}

func TestLoadHandoverAndLifecycleFlags(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MCP_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("GITHUB_ACTIONS", "")
	withArgs(t, "--root", root, "--tunnel", "hub", "--hub-urls", "https://hub.example.com", "--duration-seconds", "20400", "--idle-timeout", "900", "--predecessor-id", "runner-g1", "--generation", "2")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DurationSeconds != 20400 || c.HandoverAfter != 19800 {
		t.Fatalf("expected auto handover_after=19800, got duration=%d handover=%d", c.DurationSeconds, c.HandoverAfter)
	}
	if c.IdleTimeout != 900 || c.PredecessorID != "runner-g1" || c.Generation != 2 {
		t.Fatalf("unexpected lifecycle config: %#v", c)
	}
	if c.ShutdownToken != c.Token {
		t.Fatalf("expected ShutdownToken to default to Token")
	}

	withArgs(t, "--root", root, "--tunnel", "hub", "--hub-urls", "https://hub.example.com", "--duration-seconds", "20400", "--handover-after", "-1")
	c2, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c2.HandoverAfter != -1 {
		t.Fatalf("expected handover-after=-1 to disable handover, got %d", c2.HandoverAfter)
	}
}

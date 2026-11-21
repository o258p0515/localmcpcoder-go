package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)
func TestPersistTokenPreservesOtherEnvEntries(t *testing.T){p:=filepath.Join(t.TempDir(),".env");if e:=os.WriteFile(p,[]byte("OTHER=value\nMCP_TOKEN=old-token\nANOTHER=entry\n"),0644);e!=nil{t.Fatal(e)};if e:=persistToken(p,"new-token-0123456789");e!=nil{t.Fatal(e)};b,e:=os.ReadFile(p);if e!=nil{t.Fatal(e)};if !strings.Contains(string(b),"OTHER=value")||!strings.Contains(string(b),"ANOTHER=entry")||!strings.Contains(string(b),"MCP_TOKEN=new-token-0123456789")||strings.Contains(string(b),"old-token"){t.Fatalf("unexpected .env: %s",b)};fi,_:=os.Stat(p);if fi.Mode().Perm()!=0600{t.Fatalf("permissions %o",fi.Mode().Perm())}}

package tools

import (
 "context"
 "runtime"
 "strings"
 "testing"
)
func TestBashOutputIsBounded(t *testing.T) { if runtime.GOOS=="windows" { t.Skip("bash-specific test") }; r:=registry(t); r.D.MaxOutput=1024; res:=r.Call(context.Background(),"bash",map[string]any{"command":"yes x | head -n 10000"}); if len([]rune(res.Content[0]["text"]))>1300 { t.Fatalf("output was not bounded: %d chars",len([]rune(res.Content[0]["text"]))) }; if !strings.Contains(res.Content[0]["text"],"output truncated") { t.Fatalf("missing truncation marker: %s",res.Content[0]["text"]) } }

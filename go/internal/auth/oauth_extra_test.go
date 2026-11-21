package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)
func TestClientRegistrationAndRedirectValidation(t *testing.T){s:=New("0123456789abcdef");if s.Register("bad",nil)!=""{t.Fatal("client without redirect URIs accepted")};if s.Register("bad",[]string{"not-a-uri"})!=""{t.Fatal("relative redirect URI accepted")};cid:=s.Register("desktop",[]string{"myapp://callback"});if cid==""{t.Fatal("custom-scheme redirect rejected")};name,e:=s.ClientInfo(cid,"myapp://callback");if e!=nil||name!="desktop"{t.Fatalf("client info: %q %v",name,e)};if _,e=s.ClientInfo(cid,"myapp://attacker");e==nil{t.Fatal("unregistered redirect accepted")}}
func TestRefreshIsStatelessAndDoesNotRotate(t *testing.T){a:=New("0123456789abcdef0123456789abcdef");b:=New("0123456789abcdef0123456789abcdef");cid:=a.Register("test",[]string{"https://client/cb"});v:="verifier-which-is-long-enough-for-pkce-123456789";h:=sha256.Sum256([]byte(v));code,e:=a.AuthCode(cid,"https://client/cb",base64.RawURLEncoding.EncodeToString(h[:]),"https://host/mcp","mcp");if e!=nil{t.Fatal(e)};_,rt,e:=a.Exchange(code,v,"https://host/mcp",cid,"https://client/cb");if e!=nil{t.Fatal(e)};access,returned,e:=b.Refresh(rt);if e!=nil{t.Fatal(e)};if returned!=rt{t.Fatal("refresh token unexpectedly rotated")};if !a.Bearer(access,"https://host/mcp"){t.Fatal("stateless refreshed token rejected by another instance")}}

package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)
func TestStatelessPKCEAndAudience(t *testing.T) {
	a := New("0123456789abcdef0123456789abcdef"); b := New("0123456789abcdef0123456789abcdef"); cid := a.Register("test", []string{"https://client/cb"}); v := "a-long-random-verifier-string-for-pkce"; h := sha256.Sum256([]byte(v)); challenge := base64.RawURLEncoding.EncodeToString(h[:]); code, e := a.AuthCode(cid, "https://client/cb", challenge, "https://host/mcp", "mcp"); if e != nil { t.Fatal(e) }; if _, _, e = b.Exchange(code, "wrong", "https://host/mcp", cid, "https://client/cb"); e == nil { t.Fatal("wrong verifier accepted") }; code, e = a.AuthCode(cid, "https://client/cb", challenge, "https://host/mcp", "mcp"); if e != nil { t.Fatal(e) }; at, rt, e := a.Exchange(code, v, "https://host/mcp", cid, "https://client/cb"); if e != nil { t.Fatal(e) }; if !b.Bearer(at, "https://host/mcp") { t.Fatal("instance B rejected token") }; if b.Bearer(at, "https://other/mcp") { t.Fatal("wrong audience accepted") }; if _, _, e = a.Exchange(code, v, "https://host/mcp", cid, "https://client/cb"); e == nil { t.Fatal("single use code accepted twice") }; if _, _, e = a.Refresh(rt); e != nil { t.Fatal(e) }
}
func TestTamperedExpiredTokens(t *testing.T) { s := New("0123456789abcdef"); x := s.Sign(Claims{Typ: "access", Aud: "x", Exp: time.Now().Add(time.Hour).Unix()}); if _, e := s.Verify(x + "x"); e == nil { t.Fatal("tampered accepted") }; x = s.Sign(Claims{Typ: "access", Exp: time.Now().Add(-time.Hour).Unix()}); if _, e := s.Verify(x); e == nil { t.Fatal("expired accepted") } }
func TestLockout(t *testing.T) { s := New("0123456789abcdef"); for i := 0; i < 5; i++ { s.CheckPass("bad") }; if s.CheckPass("0123456789abcdef") { t.Fatal("lockout bypass") } }

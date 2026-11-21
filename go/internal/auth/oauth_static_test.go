package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestStaticClientAndSecret(t *testing.T) {
	s := NewWithOptions(Options{
		Passphrase:   "0123456789abcdef0123456789abcdef",
		ClientID:     "lmcp_test",
		ClientSecret: "super-secret-value-32chars-min!!",
		RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"},
		ClientName:   "Static",
	})
	if _, e := s.ClientInfo("lmcp_test", "https://claude.ai/api/mcp/auth_callback"); e != nil {
		t.Fatal(e)
	}
	if e := s.AuthenticateClient("lmcp_test", "wrong"); e == nil {
		t.Fatal("bad secret accepted")
	}
	if e := s.AuthenticateClient("lmcp_test", "super-secret-value-32chars-min!!"); e != nil {
		t.Fatal(e)
	}
	v := "a-long-random-verifier-string-for-pkce"
	h := sha256.Sum256([]byte(v))
	ch := base64.RawURLEncoding.EncodeToString(h[:])
	code, e := s.AuthCode("lmcp_test", "https://claude.ai/api/mcp/auth_callback", ch, "https://host/mcp", "mcp")
	if e != nil {
		t.Fatal(e)
	}
	at, _, e := s.Exchange(code, v, "https://host/mcp", "lmcp_test", "https://claude.ai/api/mcp/auth_callback")
	if e != nil {
		t.Fatal(e)
	}
	if !s.Bearer(at, "https://host/mcp") {
		t.Fatal("access token rejected")
	}
}

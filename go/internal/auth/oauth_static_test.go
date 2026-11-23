package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestStaticClientPKCEAndAuthentication(t *testing.T) {
	const clientID = "mcp-client"
	const clientSecret = "a-long-client-secret-for-tests"
	const redirect = "http://127.0.0.1:43123/callback"
	s := NewWithOptions(Options{
		Passphrase: "0123456789abcdef0123456789abcdef",
		ClientID: clientID, ClientSecret: clientSecret,
		AllowAnyRedirect: true,
	})
	if !s.AuthenticateClient(clientID, clientSecret) { t.Fatal("valid static client credentials rejected") }
	if s.AuthenticateClient(clientID, "wrong-secret") { t.Fatal("invalid static client secret accepted") }
	if _, err := s.ClientInfo(clientID, redirect); err != nil { t.Fatal(err) }
	if _, err := s.ClientInfo(clientID, "https://attacker.example/callback?x=1"); err != nil { t.Fatalf("arbitrary HTTPS redirect should be accepted: %v", err) }
	if _, err := s.ClientInfo(clientID, "custom-app://callback/path"); err != nil { t.Fatalf("arbitrary custom-scheme redirect should be accepted: %v", err) }
	if _, err := s.ClientInfo(clientID, "javascript://callback"); err == nil { t.Fatal("javascript redirect must remain rejected") }

	verifier := "0123456789012345678901234567890123456789012"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	code, err := s.AuthCode(clientID, redirect, challenge, "https://mcp.example.test/mcp", "mcp")
	if err != nil { t.Fatal(err) }
	access, refresh, err := s.Exchange(code, verifier, "https://mcp.example.test/mcp", clientID, redirect)
	if err != nil { t.Fatal(err) }
	if !s.Bearer(access, "https://mcp.example.test/mcp") { t.Fatal("issued access token rejected") }
	if _, _, err := s.Exchange(code, verifier, "https://mcp.example.test/mcp", clientID, redirect); err == nil { t.Fatal("authorization code was reusable") }
	if _, _, err := s.Refresh(refresh); err != nil { t.Fatal(err) }
}

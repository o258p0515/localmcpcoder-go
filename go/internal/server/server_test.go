package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tools"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPToolsResourcesAndPathGuard(t *testing.T) {
	root := t.TempDir()
	f, e := fsx.New(root, false)
	if e != nil { t.Fatal(e) }
	sk, e := skills.Load(root, "")
	if e != nil { t.Fatal(e) }
	reg := tools.New(tools.Deps{FS: f, Root: root, Shell: "bash", MaxOutput: 60000, Skills: sk})
	s := New(config.Config{Root: root, Token: "0123456789abcdef"}, reg, sk)
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	call := func(method string, params any) map[string]any {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		r, _ := http.NewRequest("POST", h.URL+"/mcp", bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer 0123456789abcdef")
		resp, e := http.DefaultClient.Do(r)
		if e != nil { t.Fatal(e) }
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	if x := call("tools/list", map[string]any{}); x["result"] == nil { t.Fatalf("tools/list failed: %#v", x) }
	x := call("resources/list", map[string]any{})
	if x["result"] == nil { t.Fatalf("resources/list failed: %#v", x) }
	x = call("tools/call", map[string]any{"name": "skill_read", "arguments": map[string]any{"name": "getting-started"}})
	if x["result"] == nil { t.Fatalf("skill_read failed: %#v", x) }
	x = call("tools/call", map[string]any{"name": "read_file", "arguments": map[string]any{"file_path": "../../etc/passwd"}})
	raw, _ := json.Marshal(x)
	if !bytes.Contains(raw, []byte("outside")) { t.Fatalf("path escape not rejected: %s", raw) }
}
func TestHTTPMethodsAndHealth(t *testing.T) {
	root := t.TempDir()
	f, _ := fsx.New(root, false)
	sk, _ := skills.Load(root, "")
	s := New(config.Config{Root: root, Token: "0123456789abcdef"}, tools.New(tools.Deps{FS: f, Root: root, MaxOutput: 1000, Skills: sk}), sk)
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	r, e := http.Get(h.URL + "/health")
	if e != nil { t.Fatal(e) }
	r.Body.Close()
	if r.StatusCode != 200 { t.Fatal(r.Status) }
	r, e = http.Get(h.URL + "/mcp")
	if e != nil { t.Fatal(e) }
	r.Body.Close()
	if r.StatusCode != 405 { t.Fatal(r.Status) }
}

func TestOAuthRegisterAuthorizeTokenAndMCP(t *testing.T) {
	root := t.TempDir()
	f, _ := fsx.New(root, false)
	sk, _ := skills.Load(root, "")
	cfg := config.Config{Root: root, Token: "0123456789abcdef0123456789abcdef"}
	srv := New(cfg, tools.New(tools.Deps{FS: f, Root: root, MaxOutput: 60000, Skills: sk}), sk)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	postJSON := func(path string, v any) map[string]any {
		b, _ := json.Marshal(v)
		r, e := http.Post(ts.URL+path, "application/json", bytes.NewReader(b))
		if e != nil { t.Fatal(e) }
		defer r.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(r.Body).Decode(&out)
		if r.StatusCode >= 300 { t.Fatalf("%s: %d %#v", path, r.StatusCode, out) }
		return out
	}
	reg := postJSON("/oauth/register", map[string]any{"client_name": "test client", "redirect_uris": []string{"http://client.local/cb"}})
	cid, _ := reg["client_id"].(string)
	if cid == "" { t.Fatal("client_id missing") }
	verifier := "0123456789abcdef0123456789abcdef0123456789abcdef"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	resource := ts.URL + "/mcp"
	form := url.Values{"client_id": {cid}, "redirect_uri": {"http://client.local/cb"}, "response_type": {"code"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "resource": {resource}, "scope": {"mcp"}, "passphrase": {cfg.Token}}
	authClient := http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	authReq, _ := http.NewRequest("POST", ts.URL+"/oauth/authorize", strings.NewReader(form.Encode()))
	authReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := authClient.Do(authReq)
	if e != nil { t.Fatal(e) }
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound { t.Fatalf("authorize status %d", resp.StatusCode) }
	loc, e := url.Parse(resp.Header.Get("Location"))
	if e != nil { t.Fatal(e) }
	code := loc.Query().Get("code")
	if code == "" || loc.Query().Get("iss") == "" { t.Fatalf("authorization redirect missing code/iss: %s", loc) }
	tokenForm := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "client_id": {cid}, "redirect_uri": {"http://client.local/cb"}, "resource": {resource}}
	resp, e = http.PostForm(ts.URL+"/oauth/token", tokenForm)
	if e != nil { t.Fatal(e) }
	defer resp.Body.Close()
	var tokens map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&tokens)
	if resp.StatusCode != 200 { t.Fatalf("token exchange failed: %d %#v", resp.StatusCode, tokens) }
	access, _ := tokens["access_token"].(string)
	if access == "" { t.Fatal("access token missing") }
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	resp, e = http.DefaultClient.Do(req)
	if e != nil { t.Fatal(e) }
	defer resp.Body.Close()
	if resp.StatusCode != 200 { t.Fatalf("OAuth token rejected by MCP: %d", resp.StatusCode) }
}

func TestSkillsReloadEmitsListChanged(t *testing.T) {
	root := t.TempDir()
	f, _ := fsx.New(root, false)
	sk, _ := skills.Load(root, "")
	cfg := config.Config{Root: root, Token: "0123456789abcdef"}
	reg := tools.New(tools.Deps{FS: f, Root: root, MaxOutput: 60000, Skills: sk})
	ts := httptest.NewServer(New(cfg, reg, sk).Handler())
	defer ts.Close()
	dir := filepath.Join(root, ".mcp", "skills", "custom-skill")
	if e := os.MkdirAll(dir, 0755); e != nil { t.Fatal(e) }
	if e := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: custom-skill\ndescription: Test reload\n---\nCustom skill body"), 0600); e != nil { t.Fatal(e) }
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"skills_reload","arguments":{}}}`
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer 0123456789abcdef")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, e := http.DefaultClient.Do(req)
	if e != nil { t.Fatal(e) }
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	for _, m := range []string{"notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/prompts/list_changed"} {
		if !bytes.Contains(b, []byte(m)) { t.Fatalf("missing %s in SSE: %s", m, b) }
	}
	if !strings.Contains(string(b), "text/event-stream") && resp.Header.Get("Content-Type") != "text/event-stream" { t.Fatalf("expected SSE content type, got %s", resp.Header.Get("Content-Type")) }
	if _, e = sk.Read("custom-skill", ""); e != nil { t.Fatalf("shared skills store not reloaded: %v", e) }
}

func TestMCPBearerSchemeIsCaseInsensitive(t *testing.T) {
 root:=t.TempDir()
 f,err:=fsx.New(root,false);if err!=nil{t.Fatal(err)}
 sk,err:=skills.Load(root,"");if err!=nil{t.Fatal(err)}
 s:=New(config.Config{Root:root,Token:"0123456789abcdef"},tools.New(tools.Deps{FS:f,Root:root,MaxOutput:1000,Skills:sk}),sk)
 h:=httptest.NewServer(s.Handler());defer h.Close()
 body:=[]byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)
 req,err:=http.NewRequest("POST",h.URL+"/mcp",bytes.NewReader(body));if err!=nil{t.Fatal(err)}
 req.Header.Set("Content-Type","application/json")
 req.Header.Set("Authorization","bearer 0123456789abcdef")
 resp,err:=http.DefaultClient.Do(req);if err!=nil{t.Fatal(err)};defer resp.Body.Close()
 if resp.StatusCode!=http.StatusOK{t.Fatalf("lowercase bearer scheme rejected: %s",resp.Status)}
}

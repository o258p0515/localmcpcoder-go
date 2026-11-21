package server

import (
	"bytes"
	"encoding/json"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tools"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)
func TestOAuthDiscoveryRegistrationAndConsent(t *testing.T){root:=t.TempDir();f,_:=fsx.New(root,false);sk,_:=skills.Load(root,"");cfg:=config.Config{Root:root,Token:"0123456789abcdef0123456789abcdef"};ts:=httptest.NewServer(New(cfg,tools.New(tools.Deps{FS:f,Root:root,MaxOutput:60000,Skills:sk}),sk).Handler());defer ts.Close();for _,path:=range []string{"/.well-known/oauth-protected-resource/mcp","/.well-known/oauth-authorization-server/mcp"}{r,e:=http.Get(ts.URL+path);if e!=nil{t.Fatal(e)};if r.StatusCode!=200{t.Fatalf("discovery %s: %d",path,r.StatusCode)};r.Body.Close()};b,_:=json.Marshal(map[string]any{"client_name":"Desktop client","redirect_uris":[]string{"myapp://callback"}});r,e:=http.Post(ts.URL+"/oauth/register","application/json",bytes.NewReader(b));if e!=nil{t.Fatal(e)};var reg map[string]any;_=json.NewDecoder(r.Body).Decode(&reg);r.Body.Close();if r.StatusCode!=201{t.Fatalf("register status %d: %#v",r.StatusCode,reg)};cid,_:=reg["client_id"].(string);if cid==""{t.Fatal("missing client id")};q:=url.Values{"client_id":{cid},"redirect_uri":{"myapp://callback"},"response_type":{"code"},"code_challenge":{"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"code_challenge_method":{"S256"}};r,e=http.Get(ts.URL+"/oauth/authorize?"+q.Encode());if e!=nil{t.Fatal(e)};body,_:=io.ReadAll(r.Body);r.Body.Close();if r.StatusCode!=200||!bytes.Contains(body,[]byte("Desktop client")){t.Fatalf("consent page status %d: %s",r.StatusCode,body)};q.Set("redirect_uri","myapp://attacker");r,e=http.Get(ts.URL+"/oauth/authorize?"+q.Encode());if e!=nil{t.Fatal(e)};r.Body.Close();if r.StatusCode!=400{t.Fatalf("unregistered redirect status %d",r.StatusCode)}}
func TestMCPMethodAndAuthChallenges(t *testing.T){root:=t.TempDir();f,_:=fsx.New(root,false);sk,_:=skills.Load(root,"");ts:=httptest.NewServer(New(config.Config{Root:root,Token:"0123456789abcdef"},tools.New(tools.Deps{FS:f,Root:root,MaxOutput:1000,Skills:sk}),sk).Handler());defer ts.Close();for _,method:=range []string{http.MethodGet,http.MethodDelete}{req,_:=http.NewRequest(method,ts.URL+"/mcp",nil);resp,e:=http.DefaultClient.Do(req);if e!=nil{t.Fatal(e)};resp.Body.Close();if resp.StatusCode!=405{t.Fatalf("%s /mcp: %d",method,resp.StatusCode)}};resp,e:=http.Get(ts.URL+"/mcp/secret");if e!=nil{t.Fatal(e)};resp.Body.Close();if resp.StatusCode!=410{t.Fatalf("legacy path: %d",resp.StatusCode)};req,_:=http.NewRequest("POST",ts.URL+"/mcp",strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`));req.Header.Set("Content-Type","application/json");resp,e=http.DefaultClient.Do(req);if e!=nil{t.Fatal(e)};resp.Body.Close();if resp.StatusCode!=401||!strings.Contains(resp.Header.Get("WWW-Authenticate"),"resource_metadata"){t.Fatalf("missing bearer challenge: %d %s",resp.StatusCode,resp.Header.Get("WWW-Authenticate"))}}

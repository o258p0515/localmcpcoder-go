package server

import (
	"encoding/json"
 "encoding/base64"
 "os"
	"fmt"
	"github.com/o258p0515/localmcpcoder-go/go/internal/auth"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"github.com/o258p0515/localmcpcoder-go/go/internal/tools"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type rpcReq struct { JSONRPC string `json:"jsonrpc"`; ID json.RawMessage `json:"id"`; Method string `json:"method"`; Params map[string]any `json:"params"` }
type rpcResp struct { JSONRPC string `json:"jsonrpc"`; ID json.RawMessage `json:"id"`; Result any `json:"result,omitempty"`; Error any `json:"error,omitempty"` }
type Server struct { cfg config.Config; tools *tools.Registry; skills *skills.Store; oauth *auth.Service }
func New(c config.Config,t *tools.Registry,sk *skills.Store)*Server{
 return &Server{cfg:c,tools:t,skills:sk,oauth:auth.NewWithOptions(auth.Options{Passphrase:c.Token,ClientID:os.Getenv("MCP_OAUTH_CLIENT_ID"),ClientSecret:os.Getenv("MCP_OAUTH_CLIENT_SECRET"),ClientName:envOr(os.Getenv("MCP_OAUTH_CLIENT_NAME"),"localmcpcoder pre-registered client"),AllowAnyRedirect:true})}
}
func envOr(v,d string)string{if v!=""{return v};return d}
func (s *Server) Handler()http.Handler{
 m:=http.NewServeMux()
 m.HandleFunc("/health",func(w http.ResponseWriter,r *http.Request){w.Header().Set("Content-Type","application/json");fmt.Fprint(w,`{"status":"ok"}`)})
 m.HandleFunc("/.well-known/oauth-protected-resource",s.resourceMeta)
 m.HandleFunc("/.well-known/oauth-protected-resource/mcp",s.resourceMeta)
 m.HandleFunc("/.well-known/oauth-authorization-server",s.asMeta)
 m.HandleFunc("/.well-known/oauth-authorization-server/mcp",s.asMeta)
 m.HandleFunc("/.well-known/openid-configuration",s.asMeta)
 m.HandleFunc("/register",s.register);m.HandleFunc("/oauth/register",s.register);m.HandleFunc("/oauth/authorize",s.authorize);m.HandleFunc("/oauth/token",s.token)
 m.HandleFunc("/mcp/",func(w http.ResponseWriter,r *http.Request){http.Error(w,"Gone: use /mcp with Authorization header",http.StatusGone)})
 m.HandleFunc("/mcp",s.mcp)
 return cors(m)
}
func(s *Server)origin(r *http.Request)string{scheme:=strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"),",")[0]);if scheme==""{if r.TLS!=nil{scheme="https"}else{scheme="http"}};host:=strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"),",")[0]);if host==""{host=r.Host};return auth.Origin(scheme,host)}
func(s *Server)resourceMeta(w http.ResponseWriter,r *http.Request){o:=s.origin(r);writeJSON(w,map[string]any{"resource":o+"/mcp","authorization_servers":[]string{o},"bearer_methods_supported":[]string{"header"},"scopes_supported":[]string{"mcp"}})}
func(s *Server)asMeta(w http.ResponseWriter,r *http.Request){o:=s.origin(r);writeJSON(w,map[string]any{"issuer":o,"authorization_endpoint":o+"/oauth/authorize","token_endpoint":o+"/oauth/token","registration_endpoint":o+"/oauth/register","response_types_supported":[]string{"code"},"grant_types_supported":[]string{"authorization_code","refresh_token"},"code_challenge_methods_supported":[]string{"S256"},"token_endpoint_auth_methods_supported":[]string{"client_secret_post","client_secret_basic","none"},"scopes_supported":[]string{"mcp"},"authorization_response_iss_parameter_supported":true})}
func(s *Server)register(w http.ResponseWriter,r *http.Request){
 if id,name,uris,ok:=s.oauth.StaticClient();ok { if r.Method=="GET" { writeJSON(w,map[string]any{"client_id":id,"client_name":name,"redirect_uris":uris,"token_endpoint_auth_method":"client_secret_basic","grant_types":[]string{"authorization_code","refresh_token"},"response_types":[]string{"code"}});return } }
 if r.Method!="POST"{http.Error(w,"POST required",405);return};var q struct{ClientName string `json:"client_name"`;RedirectURIs []string `json:"redirect_uris"`};if json.NewDecoder(r.Body).Decode(&q)!=nil{http.Error(w,"invalid JSON",400);return};name:=q.ClientName;if name==""{name="Unnamed MCP client"};id:=s.oauth.Register(name,q.RedirectURIs);if id==""{writeJSONStatus(w,400,map[string]any{"error":"invalid_redirect_uri","error_description":"redirect_uris is required and must contain absolute URIs"});return};writeJSONStatus(w,201,map[string]any{"client_id":id,"client_name":name,"redirect_uris":q.RedirectURIs,"token_endpoint_auth_method":"none","grant_types":[]string{"authorization_code","refresh_token"},"response_types":[]string{"code"},"scope":"mcp","client_id_issued_at":time.Now().Unix()})
}
var consentTmpl=template.Must(template.New("consent").Parse(`<!doctype html><html><head><meta charset="utf-8"><title>Authorize localmcpcoder</title></head><body><h1>Authorize access to this machine</h1><p><strong>{{.clientName}}</strong> is requesting access.</p><p>Approving grants shell access and the ability to read, write and delete files as your user.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="client_id" value="{{.client}}"><input type="hidden" name="redirect_uri" value="{{.redirect}}"><input type="hidden" name="response_type" value="code"><input type="hidden" name="code_challenge" value="{{.challenge}}"><input type="hidden" name="code_challenge_method" value="S256"><input type="hidden" name="resource" value="{{.resource}}"><input type="hidden" name="scope" value="{{.scope}}"><input type="hidden" name="state" value="{{.state}}"><label>Passphrase <input type="password" name="passphrase" required autofocus></label><button type="submit">Approve</button></form></body></html>`))
func(s *Server)authorize(w http.ResponseWriter,r *http.Request){
 if r.Method=="GET"{q:=r.URL.Query();if q.Get("response_type")!="code"||q.Get("code_challenge_method")!="S256"{http.Error(w,"response_type=code and PKCE S256 are required",400);return};name,e:=s.oauth.ClientInfo(q.Get("client_id"),q.Get("redirect_uri"));if e!=nil{http.Error(w,"Authorization error: "+e.Error(),400);return};for _,k:=range []string{"client_id","redirect_uri","response_type","code_challenge","code_challenge_method"}{if q.Get(k)==""{http.Error(w,"missing "+k,400);return}};_=consentTmpl.Execute(w,map[string]string{"client":q.Get("client_id"),"clientName":name,"redirect":q.Get("redirect_uri"),"challenge":q.Get("code_challenge"),"resource":q.Get("resource"),"scope":q.Get("scope"),"state":q.Get("state")});return}
 if r.Method!="POST"{http.Error(w,"method not allowed",405);return};_=r.ParseForm();if _,e:=s.oauth.ClientInfo(r.Form.Get("client_id"),r.Form.Get("redirect_uri"));e!=nil{http.Error(w,"Authorization error: "+e.Error(),400);return};if s.oauth.Locked(){http.Error(w,"too many failed attempts; try again later",429);return};if !s.oauth.CheckPass(r.Form.Get("passphrase")){http.Error(w,"Wrong passphrase",401);return};if r.Form.Get("response_type")!="code"{http.Error(w,"response_type=code is required",400);return};if r.Form.Get("code_challenge_method")!="S256"{http.Error(w,"PKCE S256 is required",400);return}
 resource:=r.Form.Get("resource");if resource==""{resource=s.origin(r)+"/mcp"};code,e:=s.oauth.AuthCode(r.Form.Get("client_id"),r.Form.Get("redirect_uri"),r.Form.Get("code_challenge"),resource,r.Form.Get("scope"));if e!=nil{http.Error(w,e.Error(),400);return};u,e:=url.Parse(r.Form.Get("redirect_uri"));if e!=nil{http.Error(w,"invalid redirect",400);return};v:=u.Query();v.Set("code",code);if st:=r.Form.Get("state");st!=""{v.Set("state",st)};v.Set("iss",s.origin(r));u.RawQuery=v.Encode();http.Redirect(w,r,u.String(),http.StatusFound)
}
func(s *Server)token(w http.ResponseWriter,r *http.Request){
 if r.Method!="POST"{http.Error(w,"POST required",405);return};_=r.ParseForm()
 clientID,clientSecret:=r.Form.Get("client_id"),r.Form.Get("client_secret")
 if h:=strings.TrimSpace(r.Header.Get("Authorization"));strings.HasPrefix(strings.ToLower(h),"basic ") { raw,e:=base64.StdEncoding.DecodeString(strings.TrimSpace(h[6:]));if e!=nil{writeJSONStatus(w,401,map[string]any{"error":"invalid_client"});return};parts:=strings.SplitN(string(raw),":",2);if len(parts)!=2{writeJSONStatus(w,401,map[string]any{"error":"invalid_client"});return};clientID,clientSecret=parts[0],parts[1] }
 if id,_,_,ok:=s.oauth.StaticClient();ok && clientID==id && !s.oauth.AuthenticateClient(clientID,clientSecret){w.Header().Set("WWW-Authenticate","Basic realm=oauth");writeJSONStatus(w,401,map[string]any{"error":"invalid_client"});return}
 switch r.Form.Get("grant_type"){case "authorization_code":a,rt,e:=s.oauth.Exchange(r.Form.Get("code"),r.Form.Get("code_verifier"),r.Form.Get("resource"),clientID,r.Form.Get("redirect_uri"));if e!=nil{writeJSONStatus(w,400,map[string]any{"error":"invalid_grant","error_description":e.Error()});return};writeJSON(w,map[string]any{"access_token":a,"token_type":"Bearer","expires_in":3600,"refresh_token":rt,"scope":defaultScope(r.Form.Get("scope"))})
case "refresh_token":
 if id,_,_,ok:=s.oauth.StaticClient();ok { if claims,e:=s.oauth.Verify(r.Form.Get("refresh_token"));e==nil && claims.CID==id && !s.oauth.AuthenticateClient(clientID,clientSecret) { writeJSONStatus(w,401,map[string]any{"error":"invalid_client"});return } }
 a,rt,e:=s.oauth.Refresh(r.Form.Get("refresh_token"));if e!=nil{writeJSONStatus(w,400,map[string]any{"error":"invalid_grant"});return};c,_:=s.oauth.Verify(a);writeJSON(w,map[string]any{"access_token":a,"token_type":"Bearer","expires_in":3600,"refresh_token":rt,"scope":defaultScope(c.Scope)})
default:writeJSONStatus(w,400,map[string]any{"error":"unsupported_grant_type"})}}
func bearerToken(header string)string{parts:=strings.Fields(header);if len(parts)!=2||!strings.EqualFold(parts[0],"Bearer"){return ""};return parts[1]}
func(s *Server)mcp(w http.ResponseWriter,r *http.Request){
 if r.Method!="POST"{w.Header().Set("Allow","POST");http.Error(w,"method not allowed",405);return};authz:=bearerToken(r.Header.Get("Authorization"));if !s.oauth.Bearer(authz,s.origin(r)+"/mcp"){w.Header().Set("WWW-Authenticate",`Bearer resource_metadata="`+s.origin(r)+`/.well-known/oauth-protected-resource", error="invalid_token", scope="mcp"`);http.Error(w,"unauthorized",401);return};if !strings.Contains(r.Header.Get("Content-Type"),"application/json"){http.Error(w,"application/json required",415);return};defer r.Body.Close();var q rpcReq;if json.NewDecoder(http.MaxBytesReader(w,r.Body,16<<20)).Decode(&q)!=nil{http.Error(w,"invalid JSON",400);return};if q.JSONRPC!="2.0"{s.reply(w,q.ID,nil,map[string]any{"code":-32600,"message":"Invalid Request"});return}
 var result any
 switch q.Method{
 case "initialize":result=map[string]any{"protocolVersion":"2025-03-26","capabilities":map[string]any{"tools":map[string]any{"listChanged":true},"resources":map[string]any{"listChanged":true},"prompts":map[string]any{"listChanged":true}},"serverInfo":map[string]any{"name":"localmcpcoder-go","version":"1.0.0"},"instructions":s.instructions()}
 case "notifications/initialized","notifications/cancelled":w.WriteHeader(202);return
 case "ping":result=map[string]any{}
 case "tools/list":result=map[string]any{"tools":s.tools.List()}
 case "tools/call":n,_:=q.Params["name"].(string);a,_:=q.Params["arguments"].(map[string]any);if a==nil{a=map[string]any{}};result=s.tools.Call(r.Context(),n,a)
 case "resources/list":result=s.resourcesList()
 case "resources/read":u,_:=q.Params["uri"].(string);if !strings.HasPrefix(u,"skill://"){s.reply(w,q.ID,nil,map[string]any{"code":-32002,"message":"Resource not found"});return};if _,e:=s.skills.Read(strings.TrimPrefix(u,"skill://"),"");e!=nil{s.reply(w,q.ID,nil,map[string]any{"code":-32002,"message":"Resource not found"});return};result=s.resourceRead(u)
 case "prompts/list":result=s.promptsList()
 case "prompts/get":n,_:=q.Params["name"].(string);if _,e:=s.skills.Read(n,"");e!=nil{s.reply(w,q.ID,nil,map[string]any{"code":-32602,"message":"Unknown prompt"});return};result=s.promptGet(n)
 default:s.reply(w,q.ID,nil,map[string]any{"code":-32601,"message":"Method not found"});return
 }
 if strings.Contains(r.Header.Get("Accept"),"text/event-stream"){w.Header().Set("Content-Type","text/event-stream");w.Header().Set("Cache-Control","no-cache");w.Header().Set("X-Accel-Buffering","no");emit:=func(v any){b,_:=json.Marshal(v);fmt.Fprintf(w,"event: message\ndata: %s\n\n",b);if f,ok:=w.(http.Flusher);ok{f.Flush()}};emit(rpcResp{"2.0",q.ID,result,nil});if q.Method=="tools/call"{name,_:=q.Params["name"].(string);if name=="skills_reload"{if v,ok:=result.(tools.Result);ok&&!v.IsError{for _,method:=range []string{"notifications/tools/list_changed","notifications/resources/list_changed","notifications/prompts/list_changed"}{emit(map[string]any{"jsonrpc":"2.0","method":method})}}}};return}
 s.reply(w,q.ID,result,nil)
}
func cors(next http.Handler)http.Handler{return http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
 w.Header().Set("Access-Control-Allow-Origin","*");w.Header().Set("Access-Control-Allow-Methods","GET, POST, OPTIONS");w.Header().Set("Access-Control-Allow-Headers","Authorization, Content-Type, Accept, MCP-Protocol-Version, Last-Event-ID");w.Header().Set("Access-Control-Expose-Headers","Mcp-Session-Id, WWW-Authenticate");w.Header().Set("Vary","Origin")
 if r.Method==http.MethodOptions { w.WriteHeader(http.StatusNoContent);return };next.ServeHTTP(w,r)
})}
func(s *Server)instructions()string{var b strings.Builder;b.WriteString("MCP tools for the configured local project. Prefer relative paths. Always read a file before editing it. Before a non-trivial task, call skill_read with the matching skill name (or read resource skill://<name>). Built-in and user skills:\n");for _,x:=range s.skills.List(){fmt.Fprintf(&b,"- %s: %s\n",x.Name,x.Description)};return b.String()}
func(s *Server)resourcesList()any{a:=[]any{};for _,x:=range s.skills.List(){a=append(a,map[string]any{"uri":"skill://"+x.Name,"name":x.Name,"description":x.Description,"mimeType":"text/markdown"})};return map[string]any{"resources":a}}
func(s *Server)resourceRead(u string)any{if !strings.HasPrefix(u,"skill://"){return map[string]any{"contents":[]any{}}};n:=strings.TrimPrefix(u,"skill://");v,e:=s.skills.Read(n,"");if e!=nil{return map[string]any{"contents":[]any{}}};return map[string]any{"contents":[]any{map[string]any{"uri":u,"mimeType":"text/markdown","text":v}}}}
func(s *Server)promptsList()any{a:=[]any{};for _,x:=range s.skills.List(){a=append(a,map[string]any{"name":x.Name,"description":x.Description})};return map[string]any{"prompts":a}}
func(s *Server)promptGet(n string)any{v,e:=s.skills.Read(n,"");if e!=nil{return map[string]any{"description":e.Error(),"messages":[]any{}}};return map[string]any{"description":"Skill: "+n,"messages":[]any{map[string]any{"role":"user","content":map[string]any{"type":"text","text":v}}}}}
func(s *Server)reply(w http.ResponseWriter,id json.RawMessage,res,err any){w.Header().Set("Content-Type","application/json");_=json.NewEncoder(w).Encode(rpcResp{"2.0",id,res,err})}
func writeJSON(w http.ResponseWriter,v any){writeJSONStatus(w,200,v)}
func writeJSONStatus(w http.ResponseWriter,status int,v any){w.Header().Set("Content-Type","application/json");w.WriteHeader(status);_=json.NewEncoder(w).Encode(v)}
func defaultScope(v string)string{if v==""{return "mcp"};return v}

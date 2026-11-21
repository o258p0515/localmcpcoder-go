package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type Cloudflare struct{}
func (Cloudflare) Name() string { return "cloudflare" }
type cfClient struct { token string; client *http.Client; baseURL string }
func (c cfClient) call(ctx context.Context,method,path string,body any,out any)error{
	var rd *strings.Reader;if body==nil{rd=strings.NewReader("")}else{b,_:=json.Marshal(body);rd=strings.NewReader(string(b))};base:=c.baseURL;if base==""{base="https://api.cloudflare.com/client/v4"};req,e:=http.NewRequestWithContext(ctx,method,base+path,rd);if e!=nil{return e};req.Header.Set("Authorization","Bearer "+c.token);req.Header.Set("Content-Type","application/json");resp,e:=c.client.Do(req);if e!=nil{return e};defer resp.Body.Close()
	var v struct{Success bool `json:"success"`;Errors []struct{Code int `json:"code"`;Message string `json:"message"`} `json:"errors"`;Result json.RawMessage `json:"result"`};if e=json.NewDecoder(resp.Body).Decode(&v);e!=nil{return e};if resp.StatusCode>=300||!v.Success{msg:="Cloudflare API request failed";if len(v.Errors)>0{msg=v.Errors[0].Message};lower:=strings.ToLower(msg);if resp.StatusCode==403||strings.Contains(lower,"permission")||strings.Contains(lower,"scope")||strings.Contains(lower,"authentication error"){msg+="; check Account:Cloudflare Tunnel:Edit, Zone:DNS:Edit, and Zone:Zone:Read token scopes"};return fmt.Errorf("%s (HTTP %d)",msg,resp.StatusCode)};if out!=nil{return json.Unmarshal(v.Result,out)};return nil
}
func (c Cloudflare) Start(ctx context.Context,cfg Config,addr string)(string,func()error,error){
	token:=os.Getenv("TUNNEL_TOKEN");var e error;host:=cfg.Host
	if token==""{api:=os.Getenv("CF_API_TOKEN");if api==""{return "",nil,fmt.Errorf("set CF_API_TOKEN or TUNNEL_TOKEN for Cloudflare")};if host==""{return "",nil,fmt.Errorf("--host is required when using CF_API_TOKEN")};client:=cfClient{token:api,client:&http.Client{Timeout:20*time.Second}};token,e=configureNamedTunnel(ctx,client,host,cfg.Port);if e!=nil{return "",nil,e}}
	if host==""{host=os.Getenv("TUNNEL_HOST")}
	bin,e:=Resolve("cloudflared",DownloadSpec{URL:cloudflaredURL(),Version:"latest",Archive:cloudflaredArchive(),EnvOverride:"CLOUDFLARED_BIN"});if e!=nil{return "",nil,e}
	port:=cfg.Port;if port==0{port=8787};runCtx,cancel:=context.WithCancel(ctx);cmd:=exec.CommandContext(runCtx,bin,"tunnel","--no-autoupdate","run");cmd.Env=append(scrub(os.Environ()),"TUNNEL_TOKEN="+token);if e=cmd.Start();e!=nil{cancel();return "",nil,e}
	go func(){current:=cmd;backoff:=time.Second;for runCtx.Err()==nil{_=current.Wait();if runCtx.Err()!=nil{return};select{case <-runCtx.Done():return;case <-time.After(backoff):};if backoff<30*time.Second{backoff*=2;if backoff>30*time.Second{backoff=30*time.Second}};current=exec.CommandContext(runCtx,bin,"tunnel","--no-autoupdate","run");current.Env=append(scrub(os.Environ()),"TUNNEL_TOKEN="+token);if current.Start()!=nil{continue}}}()
	public:="";if host!=""{public="https://"+host;if e=waitReady(ctx,public);e!=nil{cancel();return "",nil,e}};stop:=func()error{cancel();return nil};return public,stop,nil
}
func configureNamedTunnel(ctx context.Context,client cfClient,host string,port int)(string,error){
	zone,account,e:=findZone(ctx,client,host);if e!=nil{return "",e};name:="mcp-"+strings.ReplaceAll(host,".","-")
	var tunnels []struct{ID string `json:"id"`;Name string `json:"name"`;AccountID string `json:"account_id"`};if e=client.call(ctx,"GET",fmt.Sprintf("/accounts/%s/cfd_tunnel?name=%s&is_deleted=false",account,name),nil,&tunnels);e!=nil{return "",e};var id,token string
	if len(tunnels)>0{id=tunnels[0].ID}else{var made struct{ID string `json:"id"`;Token string `json:"token"`};if e=client.call(ctx,"POST","/accounts/"+account+"/cfd_tunnel",map[string]any{"name":name,"config_src":"cloudflare"},&made);e!=nil{return "",e};id=made.ID;token=made.Token}
	if token==""{if e=client.call(ctx,"GET","/accounts/"+account+"/cfd_tunnel/"+id+"/token",nil,&token);e!=nil{return "",e}};if port==0{port=8787}
	ingress:=map[string]any{"config":map[string]any{"ingress":[]any{map[string]any{"hostname":host,"service":fmt.Sprintf("http://127.0.0.1:%d",port)},map[string]any{"service":"http_status:404"}}}};if e=client.call(ctx,"PUT","/accounts/"+account+"/cfd_tunnel/"+id+"/configurations",ingress,nil);e!=nil{return "",e}
	var records []struct{ID string `json:"id"`};if e=client.call(ctx,"GET",fmt.Sprintf("/zones/%s/dns_records?type=CNAME&name=%s",zone,host),nil,&records);e!=nil{return "",e};dns:=map[string]any{"type":"CNAME","name":host,"content":id+".cfargotunnel.com","proxied":true};if len(records)>0{e=client.call(ctx,"PUT",fmt.Sprintf("/zones/%s/dns_records/%s",zone,records[0].ID),dns,nil)}else{e=client.call(ctx,"POST","/zones/"+zone+"/dns_records",dns,nil)};if e!=nil{return "",e};return token,nil
}
func findZone(ctx context.Context,c cfClient,host string)(string,string,error){parts:=strings.Split(host,".");for i:=0;i<len(parts)-1;i++{name:=strings.Join(parts[i:],".");var z []struct{ID string `json:"id"`;Name string `json:"name"`;Account struct{ID string `json:"id"`} `json:"account"`};e:=c.call(ctx,"GET","/zones?name="+name,nil,&z);if e==nil&&len(z)>0{return z[0].ID,z[0].Account.ID,nil}};return "","",fmt.Errorf("no Cloudflare zone found for %s; check Zone:Zone:Read scope and domain ownership",host)}
func cloudflaredArchive()string{if runtime.GOOS=="darwin"{return "tgz"};return ""}
func cloudflaredURL()string{osn:=runtime.GOOS;arch:=runtime.GOARCH;ext:="";if osn=="windows"{ext=".exe"};if osn=="darwin"{return fmt.Sprintf("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-%s-%s.tgz",osn,arch)};return fmt.Sprintf("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-%s-%s%s",osn,arch,ext)}
func scrub(env []string)[]string{out:=[]string{};for _,v:=range env{k:=strings.SplitN(v,"=",2)[0];if k!="CF_API_TOKEN"&&k!="TS_AUTHKEY"&&k!="MCP_TOKEN"&&k!="TUNNEL_TOKEN"{out=append(out,v)}};return out}

package tunnel

import (
	"context"
	"bytes"
	"io"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)
type Config struct { Host string; Port int; Provider string; TSHostname string; TSMode string; TSTag string; Verify bool }
type Provider interface { Name()string; Start(context.Context,Config,string)(string,func()error,error) }
func Select(name string)(Provider,error){switch name{case "none","":return none{},nil;case "cloudflare":return Cloudflare{},nil;case "tailscale":return Tailscale{},nil;default:return nil,fmt.Errorf("unknown tunnel provider %q",name)}}
type none struct{}
func(none)Name()string{return "none"}
func(none)Start(_ context.Context,_ Config,addr string)(string,func()error,error){return "http://"+addr,func()error{return nil},nil}
type Tailscale struct{}
func(Tailscale)Name()string{return "tailscale"}
func(Tailscale)Start(ctx context.Context,c Config,addr string)(public string,stop func()error,retErr error){
 if strings.TrimSpace(os.Getenv("TS_TRUST_CREDS"))!="" { tags:=configuredTSTags(c.TSTag); if e:=ensureTailscalePolicyTags(ctx,tags);e!=nil{return "",nil,fmt.Errorf("prepare Tailscale policy tags: %w",e)} }
 bin,e:=resolveTailscaleBinary("tailscale","TAILSCALE_BIN");if e!=nil{return "",nil,e};if c.TSHostname==""{host,_:=os.Hostname();if host==""{host="localmcpcoder"};c.TSHostname="mcp-"+host};if c.TSMode==""{c.TSMode="funnel"};if c.TSMode!="funnel"&&c.TSMode!="serve"{return "",nil,fmt.Errorf("--ts-mode must be funnel or serve")};port:=c.Port;if port==0{port=8787};socket:="";var daemon *exec.Cmd;tempDir:="";startedDaemon:=false
 cleanup:=func(){if daemon!=nil&&daemon.Process!=nil{_=daemon.Process.Kill();_=daemon.Wait()};if tempDir!=""{_=os.RemoveAll(tempDir)}};defer func(){if retErr!=nil{cleanup()}}()
 command:=func(args ...string)*exec.Cmd{if socket!=""{args=append([]string{"--socket="+socket},args...)};c:=exec.CommandContext(ctx,bin,args...);c.Env=scrub(os.Environ());return c}
 stopCommand:=func(args ...string)*exec.Cmd{if socket!=""{args=append([]string{"--socket="+socket},args...)};c:=exec.Command(bin,args...);c.Env=scrub(os.Environ());return c}
 if _,e=command("status").Output();e!=nil{if runtime.GOOS!="linux"{return "",nil,fmt.Errorf("Tailscale daemon is not running; on non-Linux systems install and start Tailscale first: %w",e)};if os.Getenv("TS_AUTHKEY")=="" && os.Getenv("TS_TRUST_CREDS")==""{return "",nil,fmt.Errorf("Tailscale daemon is not running; set TS_AUTHKEY or TS_TRUST_CREDS")};daemonBin,er:=resolveTailscaleBinary("tailscaled","TAILSCALED_BIN");if er!=nil{return "",nil,er};tempDir,er=os.MkdirTemp("","localmcpcoder-tailscale-");if er!=nil{return "",nil,er};socket=filepath.Join(tempDir,"tailscaled.sock");daemon=exec.CommandContext(ctx,daemonBin,"--tun=userspace-networking","--state=mem:","--socket="+socket);daemon.Stdout=os.Stderr;daemon.Stderr=os.Stderr;daemon.Env=scrub(os.Environ());if er=daemon.Start();er!=nil{return "",nil,fmt.Errorf("start tailscaled: %w",er)};startedDaemon=true;ready:=false;deadline:=time.NewTimer(30*time.Second);tick:=time.NewTicker(250*time.Millisecond);for !ready{select{case <-ctx.Done():tick.Stop();deadline.Stop();return "",nil,ctx.Err();case <-deadline.C:tick.Stop();return "",nil,fmt.Errorf("tailscaled did not become ready within 30 seconds");case <-tick.C:if _,er=command("status").Output();er==nil{ready=true}}};tick.Stop();deadline.Stop()}
 statusJSON:=func()(string,error){out,er:=command("status","--json").Output();if er!=nil{return "",er};var status struct{Self struct{DNSName string `json:"DNSName"`} `json:"Self"`};if er=json.Unmarshal(out,&status);er!=nil{return "",er};return strings.TrimSuffix(status.Self.DNSName,"."),nil}
 host,er:=statusJSON();if er!=nil{return "",nil,er};wasConnected:=host!="";if host==""{key,ke:=tailscaleAuthKey(ctx);if ke!=nil{return "",nil,ke};args:=[]string{"up","--auth-key="+key,"--hostname="+c.TSHostname,"--accept-dns=false"};if os.Getenv("TS_TRUST_CREDS")!=""{tags:=configuredTSTags(c.TSTag);if len(tags)==0{return "",nil,fmt.Errorf("no Tailscale tag configured; use --ts-tag tag:<name>")};args=append(args,"--advertise-tags="+strings.Join(tags,","))};up:=command(args...);if er=up.Run();er!=nil{return "",nil,fmt.Errorf("tailscale up failed: %w",er)};host,er=statusJSON();if er!=nil{return "",nil,er}}
 if wasConnected&&strings.TrimSpace(os.Getenv("TS_TRUST_CREDS"))!=""{tags:=configuredTSTags(c.TSTag);if er=command("set","--advertise-tags="+strings.Join(tags,",")).Run();er!=nil{return "",nil,fmt.Errorf("update existing Tailscale node tags: %w",er)}}
 if host==""{return "",nil,fmt.Errorf("Tailscale status did not include Self.DNSName")};help,helpErr:=command(c.TSMode,"--help").CombinedOutput();if helpErr!=nil&&!strings.Contains(string(help),"--bg"){return "",nil,fmt.Errorf("installed Tailscale %s command does not expose --bg; check `tailscale %s --help`",c.TSMode,c.TSMode)};if !strings.Contains(string(help),"--bg"){return "",nil,fmt.Errorf("tailscale %s --help does not advertise --bg; refusing to guess CLI flags",c.TSMode)};if er=command(c.TSMode,"--bg",fmt.Sprint(port)).Run();er!=nil{return "",nil,fmt.Errorf("tailscale %s failed; verify Funnel/Serve and HTTPS policy: %w",c.TSMode,er)}
 public="https://"+host;if c.TSMode=="funnel"{if er=waitReady(ctx,public);er!=nil{_=stopCommand("funnel","reset").Run();return "",nil,er}};stop=func()error{var e error;if c.TSMode=="funnel"{e=stopCommand("funnel","reset").Run()}else{e=stopCommand("serve","reset").Run()};if startedDaemon{_=stopCommand("logout").Run();cleanup()};return e};return public,stop,nil
}
func resolveTailscaleBinary(name,override string)(string,error){if runtime.GOOS!="linux"{if p:=os.Getenv(override);p!=""{return Resolve(name,DownloadSpec{EnvOverride:override})};if p,e:=exec.LookPath(name);e==nil{return p,nil};return "",fmt.Errorf("%s not found; install Tailscale on this platform",name)};arch:=runtime.GOARCH;if arch!="amd64"&&arch!="arm64"{return "",fmt.Errorf("Tailscale static runtime download does not support Linux %s",arch)};const version="1.104.7";url:=fmt.Sprintf("https://pkgs.tailscale.com/stable/tailscale_%s_%s.tgz",version,arch);return Resolve(name,DownloadSpec{URL:url,Version:version,Archive:"tgz",EnvOverride:override})}
func waitReady(ctx context.Context,url string)error{deadline:=time.NewTimer(60*time.Second);defer deadline.Stop();tick:=time.NewTicker(time.Second);defer tick.Stop();for{reqCtx,cancel:=context.WithTimeout(ctx,2*time.Second);req,_:=http.NewRequestWithContext(reqCtx,"GET",url+"/health",nil);resp,e:=http.DefaultClient.Do(req);cancel();if e==nil{resp.Body.Close();if resp.StatusCode==200{return nil}};select{case <-ctx.Done():return ctx.Err();case <-deadline.C:return fmt.Errorf("public endpoint did not become ready within 60 seconds");case <-tick.C:}}}

// tailscaleAuthKey returns the configured credential. The Tailscale CLI natively
// exchanges tskey-client OAuth credentials for a short-lived auth key.
func tailscaleAuthKey(ctx context.Context) (string, error) {
	_ = ctx
	if key := strings.TrimSpace(os.Getenv("TS_AUTHKEY")); key != "" { return key, nil }
	credential := strings.TrimSpace(os.Getenv("TS_TRUST_CREDS"))
	if !strings.HasPrefix(credential, "tskey-client-") { return "", fmt.Errorf("TS_TRUST_CREDS must have form tskey-client-<client-id>-<secret>") }
	_,secret,ok:=strings.Cut(strings.TrimPrefix(credential,"tskey-client-"),"-");if !ok||secret==""{return "",fmt.Errorf("TS_TRUST_CREDS has an invalid client credential format")};return secret,nil
}

func configuredTSTags(value string) []string {
 if strings.TrimSpace(value)=="" { value=os.Getenv("TS_TAG") }
 if strings.TrimSpace(value)=="" { value=os.Getenv("TS_TAGS") }
 if strings.TrimSpace(value)=="" { value="tag:localmcpcoder" }
 raw:=strings.FieldsFunc(value,func(r rune)bool{return r==','||r==' '||r=='\n'||r=='\t'})
 seen:=map[string]bool{}; out:=make([]string,0,len(raw))
 for _,tag:=range raw { tag=strings.TrimSpace(tag); if tag=="" {continue}; if !strings.HasPrefix(tag,"tag:"){tag="tag:"+tag}; if !seen[tag]{seen[tag]=true;out=append(out,tag)} }
 return out
}

func ensureTailscalePolicyTags(ctx context.Context,tags []string) error {
 credential:=strings.TrimSpace(os.Getenv("TS_TRUST_CREDS"))
 if !strings.HasPrefix(credential,"tskey-client-"){return fmt.Errorf("TS_TRUST_CREDS must have form tskey-client-<client-id>-<secret>")}
 clientID,secret,ok:=strings.Cut(strings.TrimPrefix(credential,"tskey-client-"),"-")
 if !ok||clientID==""||secret==""{return fmt.Errorf("TS_TRUST_CREDS has an invalid client credential format")}
 form:=strings.NewReader("client_id="+url.QueryEscape(clientID)+"&client_secret="+url.QueryEscape(secret))
 reqCtx,cancel:=context.WithTimeout(ctx,20*time.Second);defer cancel()
 client:=&http.Client{Timeout:20*time.Second}
 tokenReq,err:=http.NewRequestWithContext(reqCtx,http.MethodPost,"https://api.tailscale.com/api/v2/oauth/token",form);if err!=nil{return err}
 tokenReq.Header.Set("Content-Type","application/x-www-form-urlencoded")
 tokenResp,err:=client.Do(tokenReq);if err!=nil{return fmt.Errorf("request OAuth token: %w",err)};defer tokenResp.Body.Close()
 if tokenResp.StatusCode<200||tokenResp.StatusCode>=300 {
  detail,_:=io.ReadAll(io.LimitReader(tokenResp.Body,4096))
  return fmt.Errorf("Tailscale OAuth token endpoint returned HTTP %d: %s",tokenResp.StatusCode,strings.TrimSpace(string(detail)))
 }
 var tokenData map[string]json.RawMessage
 if err=json.NewDecoder(io.LimitReader(tokenResp.Body,1<<20)).Decode(&tokenData);err!=nil{return fmt.Errorf("decode OAuth token response: %w",err)}
 var accessToken string
 if raw:=tokenData["access_token"];len(raw)>0{_ = json.Unmarshal(raw,&accessToken)}
 if accessToken==""{return fmt.Errorf("OAuth response did not contain access_token")}
 apiURL:="https://api.tailscale.com/api/v2/tailnet/-/acl"
 getReq,err:=http.NewRequestWithContext(reqCtx,http.MethodGet,apiURL,nil);if err!=nil{return err}
 getReq.Header.Set("Authorization","Bearer "+accessToken);getReq.Header.Set("Accept","application/json")
 getResp,err:=client.Do(getReq);if err!=nil{return fmt.Errorf("read tailnet policy: %w",err)}
 body,readErr:=io.ReadAll(io.LimitReader(getResp.Body,4<<20));getResp.Body.Close()
 if readErr!=nil{return readErr};if getResp.StatusCode!=http.StatusOK{return fmt.Errorf("read tailnet policy returned HTTP %d; verify policy_file read access",getResp.StatusCode)}
 var policy map[string]json.RawMessage
 if err=json.Unmarshal(body,&policy);err!=nil{return fmt.Errorf("parse tailnet policy JSON: %w",err)}
 var owners map[string]json.RawMessage
 if raw,exists:=policy["tagOwners"];exists{if err=json.Unmarshal(raw,&owners);err!=nil||owners==nil{return fmt.Errorf("tailnet policy tagOwners is not a JSON object")}}else{owners=map[string]json.RawMessage{}}
 changed:=false
 for _,tag:=range tags{
  var tagOwners []string
  if raw,exists:=owners[tag];exists{
   if err=json.Unmarshal(raw,&tagOwners);err!=nil{return fmt.Errorf("tagOwners entry %q is not a string array",tag)}
  }
  foundAdmin:=false
  for _,owner:=range tagOwners{if owner=="autogroup:admin"{foundAdmin=true;break}}
  if !foundAdmin{tagOwners=append(tagOwners,"autogroup:admin");ownerJSON,_:=json.Marshal(tagOwners);owners[tag]=ownerJSON;changed=true}
 }
 if !changed{return nil}
 ownersJSON,err:=json.Marshal(owners);if err!=nil{return err};policy["tagOwners"]=ownersJSON
 updated,err:=json.MarshalIndent(policy,"","  ");if err!=nil{return err}
 etag:=getResp.Header.Get("ETag");if etag==""{return fmt.Errorf("tailnet policy response did not include ETag; refusing unsafe overwrite")}
 postReq,err:=http.NewRequestWithContext(reqCtx,http.MethodPost,apiURL,bytes.NewReader(updated));if err!=nil{return err}
 postReq.Header.Set("Authorization","Bearer "+accessToken);postReq.Header.Set("Content-Type","application/json");postReq.Header.Set("If-Match",etag)
 postResp,err:=client.Do(postReq);if err!=nil{return fmt.Errorf("write tailnet policy: %w",err)};defer postResp.Body.Close()
 if postResp.StatusCode==http.StatusPreconditionFailed{return fmt.Errorf("tailnet policy changed concurrently (HTTP 412); restart to retry safely")}
 if postResp.StatusCode<200||postResp.StatusCode>=300{return fmt.Errorf("write tailnet policy returned HTTP %d; verify policy_file write access",postResp.StatusCode)}
 return nil
}

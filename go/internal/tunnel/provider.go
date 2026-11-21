package tunnel

import (
	"context"
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
type Config struct { Host string; Port int; Provider string; TSHostname string; TSMode string; Verify bool }
type Provider interface { Name()string; Start(context.Context,Config,string)(string,func()error,error) }
func Select(name string)(Provider,error){switch name{case "none","":return none{},nil;case "cloudflare":return Cloudflare{},nil;case "tailscale":return Tailscale{},nil;default:return nil,fmt.Errorf("unknown tunnel provider %q",name)}}
type none struct{}
func(none)Name()string{return "none"}
func(none)Start(_ context.Context,_ Config,addr string)(string,func()error,error){return "http://"+addr,func()error{return nil},nil}
type Tailscale struct{}
func(Tailscale)Name()string{return "tailscale"}
func(Tailscale)Start(ctx context.Context,c Config,addr string)(public string,stop func()error,retErr error){
 bin,e:=resolveTailscaleBinary("tailscale","TAILSCALE_BIN");if e!=nil{return "",nil,e};if c.TSHostname==""{host,_:=os.Hostname();if host==""{host="localmcpcoder"};c.TSHostname="mcp-"+host};if c.TSMode==""{c.TSMode="funnel"};if c.TSMode!="funnel"&&c.TSMode!="serve"{return "",nil,fmt.Errorf("--ts-mode must be funnel or serve")};port:=c.Port;if port==0{port=8787};socket:="";var daemon *exec.Cmd;tempDir:="";startedDaemon:=false
 cleanup:=func(){if daemon!=nil&&daemon.Process!=nil{_=daemon.Process.Kill();_=daemon.Wait()};if tempDir!=""{_=os.RemoveAll(tempDir)}};defer func(){if retErr!=nil{cleanup()}}()
 command:=func(args ...string)*exec.Cmd{if socket!=""{args=append([]string{"--socket="+socket},args...)};c:=exec.CommandContext(ctx,bin,args...);c.Env=scrub(os.Environ());return c}
 stopCommand:=func(args ...string)*exec.Cmd{if socket!=""{args=append([]string{"--socket="+socket},args...)};c:=exec.Command(bin,args...);c.Env=scrub(os.Environ());return c}
 if _,e=command("status").Output();e!=nil{if runtime.GOOS!="linux"{return "",nil,fmt.Errorf("Tailscale daemon is not running; on non-Linux systems install and start Tailscale first: %w",e)};if os.Getenv("TS_AUTHKEY")==""{return "",nil,fmt.Errorf("Tailscale daemon is not running; set TS_AUTHKEY to start an ephemeral userspace node")};daemonBin,er:=resolveTailscaleBinary("tailscaled","TAILSCALED_BIN");if er!=nil{return "",nil,er};tempDir,er=os.MkdirTemp("","localmcpcoder-tailscale-");if er!=nil{return "",nil,er};socket=filepath.Join(tempDir,"tailscaled.sock");daemon=exec.CommandContext(ctx,daemonBin,"--tun=userspace-networking","--state=mem:","--socket="+socket);daemon.Stdout=os.Stderr;daemon.Stderr=os.Stderr;daemon.Env=scrub(os.Environ());if er=daemon.Start();er!=nil{return "",nil,fmt.Errorf("start tailscaled: %w",er)};startedDaemon=true;ready:=false;deadline:=time.NewTimer(30*time.Second);tick:=time.NewTicker(250*time.Millisecond);for !ready{select{case <-ctx.Done():tick.Stop();deadline.Stop();return "",nil,ctx.Err();case <-deadline.C:tick.Stop();return "",nil,fmt.Errorf("tailscaled did not become ready within 30 seconds");case <-tick.C:if _,er=command("status").Output();er==nil{ready=true}}};tick.Stop();deadline.Stop()}
 statusJSON:=func()(string,error){out,er:=command("status","--json").Output();if er!=nil{return "",er};var status struct{Self struct{DNSName string `json:"DNSName"`} `json:"Self"`};if er=json.Unmarshal(out,&status);er!=nil{return "",er};return strings.TrimSuffix(status.Self.DNSName,"."),nil}
 host,er:=statusJSON();if er!=nil{return "",nil,er};if host==""{key:=os.Getenv("TS_AUTHKEY");if key==""{return "",nil,fmt.Errorf("Tailscale is not authenticated; set TS_AUTHKEY or authenticate the existing node")};up:=command("up","--auth-key="+key,"--hostname="+c.TSHostname,"--accept-dns=false");if er=up.Run();er!=nil{return "",nil,fmt.Errorf("tailscale up failed: %w",er)};host,er=statusJSON();if er!=nil{return "",nil,er}}
 if host==""{return "",nil,fmt.Errorf("Tailscale status did not include Self.DNSName")};help,helpErr:=command(c.TSMode,"--help").CombinedOutput();if helpErr!=nil&&!strings.Contains(string(help),"--bg"){return "",nil,fmt.Errorf("installed Tailscale %s command does not expose --bg; check `tailscale %s --help`",c.TSMode,c.TSMode)};if !strings.Contains(string(help),"--bg"){return "",nil,fmt.Errorf("tailscale %s --help does not advertise --bg; refusing to guess CLI flags",c.TSMode)};if er=command(c.TSMode,"--bg",fmt.Sprint(port)).Run();er!=nil{return "",nil,fmt.Errorf("tailscale %s failed; verify Funnel/Serve and HTTPS policy: %w",c.TSMode,er)}
 public="https://"+host;if c.TSMode=="funnel"{if er=waitReady(ctx,public);er!=nil{_=stopCommand("funnel","reset").Run();return "",nil,er}};stop=func()error{var e error;if c.TSMode=="funnel"{e=stopCommand("funnel","reset").Run()}else{e=stopCommand("serve","reset").Run()};if startedDaemon{_=stopCommand("logout").Run();cleanup()};return e};return public,stop,nil
}
func resolveTailscaleBinary(name,override string)(string,error){if runtime.GOOS!="linux"{if p:=os.Getenv(override);p!=""{return Resolve(name,DownloadSpec{EnvOverride:override})};if p,e:=exec.LookPath(name);e==nil{return p,nil};return "",fmt.Errorf("%s not found; install Tailscale on this platform",name)};arch:=runtime.GOARCH;if arch!="amd64"&&arch!="arm64"{return "",fmt.Errorf("Tailscale static runtime download does not support Linux %s",arch)};const version="1.104.7";url:=fmt.Sprintf("https://pkgs.tailscale.com/stable/tailscale_%s_%s.tgz",version,arch);return Resolve(name,DownloadSpec{URL:url,Version:version,Archive:"tgz",EnvOverride:override})}
func waitReady(ctx context.Context,url string)error{deadline:=time.NewTimer(60*time.Second);defer deadline.Stop();tick:=time.NewTicker(time.Second);defer tick.Stop();for{reqCtx,cancel:=context.WithTimeout(ctx,2*time.Second);req,_:=http.NewRequestWithContext(reqCtx,"GET",url+"/health",nil);resp,e:=http.DefaultClient.Do(req);cancel();if e==nil{resp.Body.Close();if resp.StatusCode==200{return nil}};select{case <-ctx.Done():return ctx.Err();case <-deadline.C:return fmt.Errorf("public endpoint did not become ready within 60 seconds");case <-tick.C:}}}

package tools

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)
func(r *Registry)bash(ctx context.Context,a map[string]any)Result{
 cmd:=val(a,"command");if cmd==""{return fail("command is required")};cwd,e:=r.D.FS.Resolve(val(a,"cwd"));if e!=nil{return fail(e.Error())};timeout:=integer(a,"timeout_ms",120000);if timeout<1000{timeout=1000};if timeout>600000{timeout=600000};cctx,cancel:=context.WithTimeout(ctx,time.Duration(timeout)*time.Millisecond);defer cancel();var c *exec.Cmd
 switch r.D.Shell{case "bash":exe:="bash";if runtime.GOOS=="windows"{exe="bash.exe"};c=exec.CommandContext(cctx,exe,"-lc",cmd);case "powershell":exe:="pwsh";if runtime.GOOS=="windows"{exe="powershell.exe"};c=exec.CommandContext(cctx,exe,"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",cmd);case "cmd":if runtime.GOOS!="windows"{return fail("cmd shell is only available on Windows")};c=exec.CommandContext(cctx,"cmd.exe","/d","/s","/c",cmd);default:return fail("unsupported shell: "+r.D.Shell)}
 c.Dir=cwd;configureProcess(c);c.WaitDelay=2*time.Second;c.Env=scrubEnv(os.Environ());max:=r.D.MaxOutput;if max<1{max=60000};stdout,stderr:=&cappedBuffer{max:max},&cappedBuffer{max:max};c.Stdout=stdout;c.Stderr=stderr;e=c.Run();parts:=[]string{};if v:=strings.TrimRight(stdout.String(),"\r\n");v!=""{parts=append(parts,v)};if v:=strings.TrimRight(stderr.String(),"\r\n");v!=""{parts=append(parts,"[stderr]\n"+v)};s:=strings.Join(parts,"\n\n");if cctx.Err()==context.DeadlineExceeded{s+="\n[timed out after "+fmt.Sprint(timeout)+"ms — process killed]"};code:=0;if e!=nil{if x,ok:=e.(*exec.ExitError);ok{code=x.ExitCode()}else{return fail(e.Error())}};return ok(fmt.Sprintf("%s\n[exit code: %d]",s,code))
}
func scrubEnv(in []string)[]string{out:=make([]string,0,len(in));for _,v:=range in{k:=strings.SplitN(v,"=",2)[0];switch k{case "CF_API_TOKEN","TS_AUTHKEY","MCP_TOKEN","TUNNEL_TOKEN":continue};out=append(out,v)};return out}
type cappedBuffer struct{bytes.Buffer;max int;truncated bool}
func(b *cappedBuffer)Write(p []byte)(int,error){n:=len(p);remaining:=b.max-b.Len();if remaining>0{if remaining>n{remaining=n};_,_=b.Buffer.Write(p[:remaining])};if remaining<n{b.truncated=true};return n,nil}
func(b *cappedBuffer)String()string{v:=b.Buffer.String();if b.truncated{return v+"\n[stream truncated]"};return v}

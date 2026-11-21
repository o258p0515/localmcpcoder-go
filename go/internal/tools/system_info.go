package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
)
func (r *Registry) sys(_ context.Context,_ map[string]any)Result{h,_:=os.Hostname();release:=systemRelease();u,_:=user.Current();username:="unknown";if u!=nil{username=u.Username};outside:="no";if r.D.Config.AllowOutsideRoot{outside="yes"};return ok(fmt.Sprintf("OS: %s %s (%s/%s)\nHost: %s\nUser: %s\nGo: %s\nShell: %s\nAllowed root: %s\nAccess outside root: %s",runtime.GOOS,release,runtime.GOOS,runtime.GOARCH,h,username,runtime.Version(),r.D.Shell,r.D.Root,outside))}
func systemRelease()string{switch runtime.GOOS{case "linux":if b,e:=os.ReadFile("/etc/os-release");e==nil{for _,line:=range strings.Split(string(b),"\n"){if strings.HasPrefix(line,"PRETTY_NAME="){return strings.Trim(strings.TrimPrefix(line,"PRETTY_NAME="),"\"")}}};case "darwin":if b,e:=exec.Command("sw_vers","-productVersion").Output();e==nil{return strings.TrimSpace(string(b))};case "windows":if b,e:=exec.Command("cmd.exe","/c","ver").Output();e==nil{return strings.TrimSpace(string(b))}};return "unknown"}

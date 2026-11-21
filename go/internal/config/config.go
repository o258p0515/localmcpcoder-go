package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)
type Config struct { Root string; Port int; Token string; Shell string; MaxOutput int; AllowOutsideRoot bool; Tunnel string; Host string; SkillsDir string; TSHostname string; TSMode string; TSTag string }
func env(k,d string)string{if v:=os.Getenv(k);v!=""{return v};return d}
func envBool(k string)bool{v:=strings.ToLower(env(k,"false"));return v=="1"||v=="true"||v=="yes"}
func Load()(Config,error){
 var c Config;root:=flag.String("root",env("MCP_ROOT","."),"allowed filesystem root");port:=flag.Int("port",atoi(env("MCP_PORT","8787"),8787),"HTTP port");shellDefault:="bash";if runtime.GOOS=="windows"{shellDefault="powershell"};shell:=flag.String("shell",env("MCP_SHELL",shellDefault),"bash, powershell, or cmd");max:=flag.Int("max-output",atoi(env("MCP_MAX_OUTPUT","60000"),60000),"maximum tool output characters");outside:=flag.Bool("allow-outside-root",envBool("MCP_ALLOW_OUTSIDE_ROOT"),"allow file access outside root");tunnel:=flag.String("tunnel",env("MCP_TUNNEL","auto"),"cloudflare, tailscale, none, or auto");host:=flag.String("host",env("MCP_HOST",""),"public hostname");skills:=flag.String("skills-dir",env("MCP_SKILLS_DIR",""),"additional skills directory");tsHost:=flag.String("ts-hostname",env("TS_HOSTNAME",""),"Tailscale hostname");tsMode:=flag.String("ts-mode",env("TS_MODE","funnel"),"Tailscale funnel or serve");tsTag:=flag.String("ts-tag",env("TS_TAG",env("TS_TAGS","tag:localmcpcoder")),"Tailscale device tag");flag.Parse()
 abs,err:=filepath.Abs(*root);if err!=nil{return c,err};c=Config{Root:abs,Port:*port,Shell:*shell,MaxOutput:*max,AllowOutsideRoot:*outside,Tunnel:*tunnel,Host:*host,SkillsDir:*skills,TSHostname:*tsHost,TSMode:*tsMode,TSTag:*tsTag,Token:os.Getenv("MCP_TOKEN")}
 if c.Port<1||c.Port>65535{return c,errors.New("port must be between 1 and 65535")};if c.MaxOutput<1{return c,errors.New("max-output must be positive")}
 if c.Token==""&&os.Getenv("GITHUB_ACTIONS")!="true"{envPath:=filepath.Join(c.Root,".env");if fi,er:=os.Lstat(envPath);er==nil{if fi.Mode()&os.ModeSymlink!=0{return c,errors.New("refusing to read a symlinked .env file")};_=os.Chmod(envPath,0600)};c.Token=tokenFromEnvFile(envPath)}
 if c.Token==""{if os.Getenv("GITHUB_ACTIONS")=="true"{return c,errors.New("MCP_TOKEN is required in GitHub Actions; refusing to generate a secret in CI")};b:=make([]byte,24);if _,err:=rand.Read(b);err!=nil{return c,err};c.Token=hex.EncodeToString(b);if err:=os.MkdirAll(c.Root,0755);err!=nil{return c,err};envPath:=filepath.Join(c.Root,".env");if fi,er:=os.Lstat(envPath);er==nil&&fi.Mode()&os.ModeSymlink!=0{return c,errors.New("refusing to overwrite a symlinked .env file")};if err:=persistToken(envPath,c.Token);err!=nil{return c,fmt.Errorf("save generated token: %w",err)};_=os.Chmod(envPath,0600)}
 if len(c.Token)<16{return c,errors.New("MCP_TOKEN must be at least 16 characters")};if c.Shell!="bash"&&c.Shell!="powershell"&&c.Shell!="cmd"{return c,fmt.Errorf("shell must be bash, powershell, or cmd")};if c.TSMode!="funnel"&&c.TSMode!="serve"{return c,errors.New("ts-mode must be funnel or serve")};if c.Tunnel!="auto"&&c.Tunnel!="none"&&c.Tunnel!="cloudflare"&&c.Tunnel!="tailscale"{return c,fmt.Errorf("unknown tunnel provider %q",c.Tunnel)}
 if os.Getenv("GITHUB_ACTIONS")=="true"{fmt.Fprintln(os.Stdout,"::add-mask::"+c.Token);for _,k:=range []string{"CF_API_TOKEN","TS_AUTHKEY","TS_TRUST_CREDS","TUNNEL_TOKEN"}{if v:=os.Getenv(k);v!=""{fmt.Fprintln(os.Stdout,"::add-mask::"+v)}}};return c,nil
}
func atoi(s string,d int)int{v,e:=strconv.Atoi(s);if e!=nil{return d};return v}
func tokenFromEnvFile(path string)string{b,e:=os.ReadFile(path);if e!=nil{return ""};for _,line:=range strings.Split(string(b),"\n"){line=strings.TrimSpace(line);if strings.HasPrefix(line,"MCP_TOKEN="){return strings.TrimSpace(strings.TrimPrefix(line,"MCP_TOKEN="))}};return ""}
func persistToken(path,token string)error{var lines []string;if b,e:=os.ReadFile(path);e==nil{for _,line:=range strings.Split(strings.TrimRight(string(b),"\r\n"),"\n"){if strings.HasPrefix(strings.TrimSpace(line),"MCP_TOKEN="){continue};if strings.TrimSpace(line)!=""{lines=append(lines,line)}}}else if !os.IsNotExist(e){return e};lines=append(lines,"MCP_TOKEN="+token);if e:=os.WriteFile(path,[]byte(strings.Join(lines,"\n")+"\n"),0600);e!=nil{return e};return os.Chmod(path,0600)}

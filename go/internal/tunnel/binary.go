package tunnel

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type DownloadSpec struct {
	URL string
	Version string
	SHA256 string
	Archive string
	EnvOverride string
}

func Resolve(name string, d DownloadSpec) (string, error) {
	if d.EnvOverride != "" {
		if p := os.Getenv(d.EnvOverride); p != "" {
			if executable(p) { log.Printf("tunnel: using %s from %s", name, d.EnvOverride); return p, nil }
			return "", fmt.Errorf("%s points to a non-executable file", d.EnvOverride)
		}
	}
	if p,e:=exec.LookPath(name);e==nil{log.Printf("tunnel: using %s from PATH",name);return p,nil}
	cache,e:=os.UserCacheDir();if e!=nil{return "",e};version:=d.Version;if version==""{version="latest"};dir:=filepath.Join(cache,"localmcpcoder","bin");if e=os.MkdirAll(dir,0755);e!=nil{return "",e};ext:="";if runtime.GOOS=="windows"{ext=".exe"};target:=filepath.Join(dir,name+"-"+version+ext)
	if executable(target){log.Printf("tunnel: using cached %s",target);return target,nil}
	if !strings.HasPrefix(d.URL,"https://"){return "",fmt.Errorf("binary download URL must use HTTPS")};log.Printf("tunnel: downloading %s from HTTPS release URL",name)
	ctx,cancel:=context.WithTimeout(context.Background(),2*time.Minute);defer cancel();var last error
	for i:=0;i<3;i++{req,_:=http.NewRequestWithContext(ctx,"GET",d.URL,nil);resp,er:=http.DefaultClient.Do(req);if er!=nil{last=er;continue};if resp.StatusCode!=200{resp.Body.Close();last=fmt.Errorf("download returned HTTP %d",resp.StatusCode);continue};tmp:=target+fmt.Sprintf(".tmp-%d",os.Getpid());f,er:=os.Create(tmp);if er==nil{_,er=io.Copy(f,resp.Body);f.Close()};resp.Body.Close();if er!=nil{os.Remove(tmp);last=er;continue}
		if d.SHA256!=""{data,he:=os.ReadFile(tmp);if he!=nil{os.Remove(tmp);last=he;continue};sum:=sha256.Sum256(data);if !strings.EqualFold(hex.EncodeToString(sum[:]),d.SHA256){os.Remove(tmp);last=fmt.Errorf("SHA256 checksum mismatch for %s",name);continue}}
		if d.Archive=="tgz"||d.Archive=="zip"{stage:=target+".stage";_=os.RemoveAll(stage);_=os.MkdirAll(stage,0700);if d.Archive=="tgz"{er=extractTGZ(tmp,stage,name)}else{er=extractZIP(tmp,stage,name)};if er==nil{extracted:=filepath.Join(stage,name);if runtime.GOOS=="windows"{if _,se:=os.Stat(extracted);os.IsNotExist(se){extracted+=".exe"}};er=os.Rename(extracted,target)};_=os.RemoveAll(stage)}else{er=os.Rename(tmp,target)}
		os.Remove(tmp);if er!=nil{last=er;time.Sleep(time.Duration(i+1)*200*time.Millisecond);continue};_=os.Chmod(target,0755);return target,nil
	}
	return "",fmt.Errorf("download %s: %w",name,last)
}
func executable(p string)bool{s,e:=os.Stat(p);return e==nil&&!s.IsDir()&&(runtime.GOOS=="windows"||s.Mode()&0111!=0)}
func extractTGZ(src,dir,name string)error{f,e:=os.Open(src);if e!=nil{return e};defer f.Close();g,e:=gzip.NewReader(f);if e!=nil{return e};defer g.Close();t:=tar.NewReader(g);for{h,e:=t.Next();if e==io.EOF{break};if e!=nil{return e};base:=filepath.Base(h.Name);if base==name||base==name+".exe"{dst:=filepath.Join(dir,base);o,e:=os.OpenFile(dst,os.O_CREATE|os.O_TRUNC|os.O_WRONLY,0755);if e!=nil{return e};_,e=io.Copy(o,t);o.Close();return e}};return fmt.Errorf("%s not found in archive",name)}
func extractZIP(src,dir,name string)error{z,e:=zip.OpenReader(src);if e!=nil{return e};defer z.Close();for _,f:=range z.File{base:=filepath.Base(f.Name);if base==name||base==name+".exe"{r,e:=f.Open();if e!=nil{return e};o,e:=os.OpenFile(filepath.Join(dir,base),os.O_CREATE|os.O_TRUNC|os.O_WRONLY,0755);if e!=nil{r.Close();return e};_,e=io.Copy(o,r);o.Close();r.Close();return e}};return fmt.Errorf("%s not found in archive",name)}

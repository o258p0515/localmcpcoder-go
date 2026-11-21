package tools

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)
func (r *Registry) grep(_ context.Context,a map[string]any)Result{pat:=val(a,"pattern");if a["case_insensitive"]==true{pat="(?i)"+pat};re,e:=regexp.Compile(pat);if e!=nil{return fail(e.Error())};root:=r.D.Root;if p:=val(a,"dir_path");p!=""{root,e=r.D.FS.Resolve(p);if e!=nil{return fail(e.Error())}};var out []string;count:=0;r.walk(root,func(p string,_ fs.DirEntry)bool{limit:=integer(a,"max_results",200);if limit<1||limit>1000{limit=200};if count>=limit{return false};fi,e:=os.Stat(p);if e!=nil||fi.Size()>2<<20{return true};b,e:=os.ReadFile(p);if e!=nil||strings.IndexByte(string(b),0)>=0{return true};if g:=val(a,"glob");g!=""{ok,_:=filepath.Match(strings.ToLower(g),strings.ToLower(filepath.Base(p)));if !ok{return true}};sc:=bufio.NewScanner(strings.NewReader(string(b)));sc.Buffer(make([]byte,4096),2<<20);for i:=1;sc.Scan();i++{if re.MatchString(sc.Text()){line:=strings.TrimSpace(sc.Text());if rr:=[]rune(line);len(rr)>300{line=string(rr[:300])};out=append(out,fmt.Sprintf("%s:%d: %s",p,i,line));count++;if count>=limit{break}}};return true});if len(out)==0{return ok(fmt.Sprintf("No matches for /%s/ in %s",val(a,"pattern"),root))};return ok(strings.Join(out,"\n"))}

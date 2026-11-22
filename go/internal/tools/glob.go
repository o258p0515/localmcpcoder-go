package tools

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)
var ignored=map[string]bool{"node_modules":true,".git":true,".venv":true,"venv":true,"__pycache__":true,"dist":true,"build":true,".next":true,".cache":true,".idea":true,".gradle":true,"target":true}
var stopWalk=fmt.Errorf("stop walk")
func (r *Registry) walk(root string,fn func(string,fs.DirEntry)bool){
 _=filepath.WalkDir(root,func(p string,d fs.DirEntry,e error)error{
  if e!=nil{return nil}
  rel,err:=filepath.Rel(root,p);if err!=nil{return nil}
  depth:=0;if rel!="."{depth=len(strings.Split(filepath.Clean(rel),string(filepath.Separator)))}
  if d.IsDir()&&p!=root{if ignored[d.Name()]||depth>25{return filepath.SkipDir}}
  if !d.IsDir()&&!fn(p,d){return stopWalk}
  return nil
 })
}
func (r *Registry) glob(_ context.Context,a map[string]any)Result{pattern:=val(a,"pattern");if pattern==""{return fail("pattern is required")};root:=r.D.Root;if d:=val(a,"dir_path");d!=""{var e error;root,e=r.D.FS.Resolve(d);if e!=nil{return fail(e.Error())}};re,e:=globRegexp(pattern);if e!=nil{return fail(e.Error())};type matchFile struct{path string;mtime time.Time};var found []matchFile;r.walk(root,func(p string,_ fs.DirEntry)bool{rel,er:=filepath.Rel(root,p);if er==nil&&re.MatchString(filepath.ToSlash(rel)){st,er:=os.Stat(p);if er==nil{found=append(found,matchFile{p,st.ModTime()})}};return true});sort.Slice(found,func(i,j int)bool{return found[i].mtime.After(found[j].mtime)});var out []string;for _,f:=range found{out=append(out,f.path)};if len(out)==0{return ok(fmt.Sprintf("No matches for %q in %s",pattern,root))};return ok(strings.Join(out,"\n"))}
func globRegexp(pattern string)(*regexp.Regexp,error){var b strings.Builder;b.WriteString("^");for i:=0;i<len(pattern);i++{c:=pattern[i];if c=='*'{if i+1<len(pattern)&&pattern[i+1]=='*'{i++;if i+1<len(pattern)&&pattern[i+1]=='/'{i++;b.WriteString("(?:.*/)?")}else{b.WriteString(".*")}}else{b.WriteString("[^/]*")}}else if c=='?'{b.WriteString("[^/]")}else if c=='['{j:=strings.IndexByte(pattern[i+1:],']');if j<0{return nil,fmt.Errorf("invalid glob character class")};j+=i+1;class:=pattern[i+1:j];if class==""{return nil,fmt.Errorf("empty glob character class")};if strings.HasPrefix(class,"!"){class="^"+class[1:]}else if strings.HasPrefix(class,"^"){class="\\"+class};b.WriteString("[");b.WriteString(class);b.WriteString("]");i=j}else{b.WriteString(regexp.QuoteMeta(string(c)))}};b.WriteString("$");return regexp.Compile(b.String())}

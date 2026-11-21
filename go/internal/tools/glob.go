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
func (r *Registry) walk(root string,fn func(string,fs.DirEntry)bool){_=filepath.WalkDir(root,func(p string,d fs.DirEntry,e error)error{if e!=nil{return nil};rel,_:=filepath.Rel(root,p);depth:=len(strings.Split(filepath.Clean(rel),string(filepath.Separator)));if d.IsDir()&&p!=root{if ignored[d.Name()]||depth>25{return filepath.SkipDir}};if !d.IsDir(){fn(p,d)};return nil})}
func (r *Registry) glob(_ context.Context,a map[string]any)Result{pattern:=val(a,"pattern");if pattern==""{return fail("pattern is required")};root:=r.D.Root;if d:=val(a,"dir_path");d!=""{var e error;root,e=r.D.FS.Resolve(d);if e!=nil{return fail(e.Error())}};re,e:=globRegexp(pattern);if e!=nil{return fail(e.Error())};type matchFile struct{path string;mtime time.Time};var found []matchFile;_=filepath.WalkDir(root,func(p string,d fs.DirEntry,e error)error{if e!=nil{return nil};rel,_:=filepath.Rel(root,p);first:=strings.Split(filepath.ToSlash(rel),"/")[0];if d.IsDir()&&p!=root&&ignored[first]{return filepath.SkipDir};if !d.IsDir()&&re.MatchString(filepath.ToSlash(rel)){st,er:=os.Stat(p);if er==nil{found=append(found,matchFile{p,st.ModTime()})}};return nil});sort.Slice(found,func(i,j int)bool{return found[i].mtime.After(found[j].mtime)});var out []string;for _,f:=range found{out=append(out,f.path)};if len(out)==0{return ok(fmt.Sprintf("No matches for %q in %s",pattern,root))};if len(out)>500{out=out[:500]};return ok(strings.Join(out,"\n"))}
func globRegexp(pattern string)(*regexp.Regexp,error){var b strings.Builder;b.WriteString("^");for i:=0;i<len(pattern);i++{c:=pattern[i];if c=='*'{if i+1<len(pattern)&&pattern[i+1]=='*'{i++;if i+1<len(pattern)&&pattern[i+1]=='/'{i++;b.WriteString("(?:.*/)?")}else{b.WriteString(".*")}}else{b.WriteString("[^/]*")}}else if c=='?'{b.WriteString("[^/]")}else if c=='['{j:=strings.IndexByte(pattern[i+1:],']');if j<0{return nil,fmt.Errorf("invalid glob character class")};j+=i+1;class:=pattern[i+1:j];if class==""{return nil,fmt.Errorf("empty glob character class")};if strings.HasPrefix(class,"!"){class="^"+class[1:]}else if strings.HasPrefix(class,"^"){class="\\"+class};b.WriteString("[");b.WriteString(class);b.WriteString("]");i=j}else{b.WriteString(regexp.QuoteMeta(string(c)))}};b.WriteString("$");return regexp.Compile(b.String())}

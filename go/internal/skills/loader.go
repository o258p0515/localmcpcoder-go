package skills

import (
	"fmt"
	embedded "github.com/o258p0515/localmcpcoder-go/go/skills"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)
type Skill struct { Name string `json:"name"`; Description string `json:"description"`; Body string `json:"body"`; Source string `json:"source"`; Dir string `json:"-"` }
type Store struct { mu sync.RWMutex; items map[string]Skill }
func Load(root,userDir string)(*Store,error){
 s:=&Store{items:map[string]Skill{}};entries,err:=fs.ReadDir(embedded.Files,".");if err!=nil{return nil,err};for _,e:=range entries{if !e.IsDir(){continue};b,er:=embedded.Files.ReadFile(e.Name()+"/SKILL.md");if er!=nil{continue};x,er:=parse(string(b));if er!=nil{return nil,er};x.Source="builtin";s.items[x.Name]=x}
 dirs:=[]string{};if userDir!=""{dirs=append(dirs,userDir)};if root!=""{dirs=append(dirs,filepath.Join(root,".mcp","skills"))}
 for _,d:=range dirs{walkErr:=filepath.WalkDir(d,func(p string,de fs.DirEntry,e error)error{if e!=nil{return nil};if de.IsDir()||de.Type()&fs.ModeSymlink!=0{return nil};if de.Name()!="SKILL.md"{return nil};b,er:=os.ReadFile(p);if er!=nil{return nil};x,er:=parse(string(b));if er!=nil{return er};x.Source="user";x.Dir=filepath.Dir(p);s.items[x.Name]=x;return nil});if walkErr!=nil&&!os.IsNotExist(walkErr){return nil,walkErr}}
 return s,nil
}
func parse(v string)(Skill,error){var x Skill;if !strings.HasPrefix(v,"---\n"){return x,fmt.Errorf("skill missing YAML frontmatter")};z:=strings.SplitN(v[4:],"\n---",2);if len(z)!=2{return x,fmt.Errorf("invalid skill frontmatter")};for _,l:=range strings.Split(z[0],"\n"){p:=strings.SplitN(l,":",2);if len(p)!=2{continue};k,val:=strings.TrimSpace(p[0]),strings.Trim(strings.TrimSpace(p[1]),"\"'");if k=="name"{x.Name=val};if k=="description"{x.Description=val}};if x.Name==""||x.Description==""{return x,fmt.Errorf("skill frontmatter requires name and description")};if strings.ContainsAny(x.Name,"/\\")||x.Name=="."||x.Name==".."{return x,fmt.Errorf("invalid skill name")};x.Body=strings.TrimSpace(z[1]);return x,nil}
func(s *Store)List()[]Skill{s.mu.RLock();defer s.mu.RUnlock();out:=make([]Skill,0,len(s.items));for _,v:=range s.items{out=append(out,Skill{Name:v.Name,Description:v.Description,Source:v.Source})};sort.Slice(out,func(i,j int)bool{return out[i].Name<out[j].Name});return out}
func(s *Store)Read(name,file string)(string,error){s.mu.RLock();defer s.mu.RUnlock();x,ok:=s.items[name];if !ok{return "",fmt.Errorf("unknown skill %q",name)};if file==""||file=="SKILL.md"{return x.Body,nil};if x.Source!="user"{return "",fmt.Errorf("built-in skill has no extra files")};clean:=filepath.Clean(file);if filepath.IsAbs(clean)||clean==".."||strings.HasPrefix(clean,".."+string(filepath.Separator)){return "",fmt.Errorf("invalid skill file path")};target:=filepath.Join(x.Dir,clean);realBase,e:=filepath.EvalSymlinks(x.Dir);if e!=nil{return "",e};realTarget,e:=filepath.EvalSymlinks(target);if e!=nil{return "",e};rel,e:=filepath.Rel(realBase,realTarget);if e!=nil||rel==".."||strings.HasPrefix(rel,".."+string(filepath.Separator))||filepath.IsAbs(rel){return "",fmt.Errorf("skill file resolves outside its skill directory")};b,e:=os.ReadFile(realTarget);return string(b),e}
func(s *Store)Reload(root,userDir string)error{next,e:=Load(root,userDir);if e!=nil{return e};s.mu.Lock();s.items=next.items;s.mu.Unlock();return nil}

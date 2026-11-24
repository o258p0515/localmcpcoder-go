package skills

import (
	"os"
	"path/filepath"
	"testing"
)
func TestLoadAndTraversal(t *testing.T){root:=t.TempDir();d:=filepath.Join(root,".mcp","skills","getting-started");if e:=os.MkdirAll(d,0755);e!=nil{t.Fatal(e)};_=os.WriteFile(filepath.Join(d,"SKILL.md"),[]byte("---\nname: getting-started\ndescription: User override\n---\nUser body"),0600);s,e:=Load(root,"");if e!=nil{t.Fatal(e)};v,e:=s.Read("getting-started","");if e!=nil||v!="User body"{t.Fatalf("override failed: %q %v",v,e)};if _,e=s.Read("getting-started","../secret");e==nil{t.Fatal("traversal allowed")};secret:=filepath.Join(root,"outside-secret");_=os.WriteFile(secret,[]byte("secret"),0600);if e:=os.Symlink(secret,filepath.Join(d,"linked-secret"));e==nil{if _,e=s.Read("getting-started","linked-secret");e==nil{t.Fatal("symlink escape allowed")}};if len(s.List())<7{t.Fatal("builtins missing")}}
func TestLoaderSkipsSymlinkedSkillFilesAndRejectsMalformedFrontmatter(t *testing.T){root:=t.TempDir();dir:=filepath.Join(root,".mcp","skills","linked");if e:=os.MkdirAll(dir,0755);e!=nil{t.Fatal(e)};outside:=filepath.Join(root,"outside-skill.md");if e:=os.WriteFile(outside,[]byte("---\nname: linked\ndescription: linked\n---\nbody"),0600);e!=nil{t.Fatal(e)};if e:=os.Symlink(outside,filepath.Join(dir,"SKILL.md"));e!=nil{t.Skip(e)};s,e:=Load(root,"");if e!=nil{t.Fatal(e)};if _,e=s.Read("linked","");e==nil{t.Fatal("symlinked SKILL.md was loaded")};bad:=filepath.Join(root,".mcp","skills","bad");if e:=os.MkdirAll(bad,0755);e!=nil{t.Fatal(e)};if e:=os.WriteFile(filepath.Join(bad,"SKILL.md"),[]byte("name: bad\n"),0600);e!=nil{t.Fatal(e)};if _,e=Load(root,"");e==nil{t.Fatal("malformed frontmatter accepted")}}

func TestParseAcceptsCRLFFontmatter(t *testing.T) {
	got, err := parse("---\r\nname: windows-skill\r\ndescription: Windows line endings\r\n---\r\nBody with CRLF\r\n")
	if err != nil { t.Fatal(err) }
	if got.Name != "windows-skill" || got.Description != "Windows line endings" || got.Body != "Body with CRLF" { t.Fatalf("unexpected parsed skill: %#v", got) }
}

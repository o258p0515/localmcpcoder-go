package tools

import (
 "context"
 "io/fs"
 "os"
 "path/filepath"
 "strings"
 "testing"

 "github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
)

func TestGlobSkipsNestedIgnoredDirectories(t *testing.T) {
 root:=t.TempDir()
 for path,body:=range map[string]string{
  "src/keep.txt":"keep",
  "src/node_modules/pkg/ignored.txt":"ignored",
  "src/.git/ignored.txt":"ignored",
 } {
  full:=filepath.Join(root,path)
  if err:=os.MkdirAll(filepath.Dir(full),0755);err!=nil{t.Fatal(err)}
  if err:=os.WriteFile(full,[]byte(body),0644);err!=nil{t.Fatal(err)}
 }
 resolver,err:=fsx.New(root,false);if err!=nil{t.Fatal(err)}
 r:=&Registry{D:Deps{Root:root,FS:resolver}}
 result:=r.glob(context.Background(),map[string]any{"pattern":"**/*.txt"})
 if result.IsError{t.Fatalf("glob failed: %#v",result)}
 output:=result.Content[0]["text"]
 if !strings.Contains(output,"keep.txt"){t.Fatalf("expected normal file in results: %s",output)}
 if strings.Contains(output,"node_modules")||strings.Contains(output,".git"){t.Fatalf("ignored nested directory leaked into results: %s",output)}
}

func TestWalkStopsWhenCallbackReturnsFalse(t *testing.T) {
 root:=t.TempDir()
 for _,name:=range []string{"a.txt","b.txt","c.txt"}{
  if err:=os.WriteFile(filepath.Join(root,name),[]byte(name),0644);err!=nil{t.Fatal(err)}
 }
 r:=&Registry{}
 count:=0
 r.walk(root,func(string,fs.DirEntry)bool{count++;return false})
 if count!=1{t.Fatalf("walk should stop after first file, visited %d",count)}
}

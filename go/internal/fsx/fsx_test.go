package fsx

import (
	"os"
	"path/filepath"
	"testing"
)
func TestResolveRejectsTraversalAndSymlink(t *testing.T){root:=t.TempDir();outside:=t.TempDir();r,e:=New(root,false);if e!=nil{t.Fatal(e)};if _,e=r.Resolve("../escape");e==nil{t.Fatal("expected traversal rejection")};if _,e=r.Resolve(filepath.Join(outside,"absolute-escape"));e==nil{t.Fatal("expected absolute outside path rejection")};if p,e:=r.Resolve(filepath.Join(root,"absolute-inside"));e!=nil||!filepath.IsAbs(p){t.Fatalf("absolute path inside root rejected: %s %v",p,e)};if e=os.Symlink(outside,filepath.Join(root,"link"));e!=nil{t.Skip(e)};if _,e=r.Resolve("link/file");e==nil{t.Fatal("expected symlink escape rejection")};if p,e:=r.Resolve("new/deep/file");e!=nil||!filepath.IsAbs(p){t.Fatalf("missing path: %s %v",p,e)}}
func TestRootBehindSymlink(t *testing.T){d:=t.TempDir();real:=filepath.Join(d,"real");if e:=os.Mkdir(real,0755);e!=nil{t.Fatal(e)};link:=filepath.Join(d,"alias");if e:=os.Symlink(real,link);e!=nil{t.Skip(e)};r,e:=New(link,false);if e!=nil{t.Fatal(e)};if _,e=r.Resolve("ok");e!=nil{t.Fatal(e)}}
func TestResolveRejectsDanglingSymlinkEscape(t *testing.T){root:=t.TempDir();r,e:=New(root,false);if e!=nil{t.Fatal(e)};link:=filepath.Join(root,"dangling");if e=os.Symlink(filepath.Join(t.TempDir(),"missing"),link);e!=nil{t.Skip(e)};if _,e=r.Resolve("dangling/new-file");e==nil{t.Fatal("dangling symlink escape was accepted")}}

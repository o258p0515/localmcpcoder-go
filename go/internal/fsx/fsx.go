package fsx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)
type Resolver struct { Root, RealRoot string; AllowOutside bool }
func New(root string,allow bool)(*Resolver,error){a,e:=filepath.Abs(root);if e!=nil{return nil,e};if e=os.MkdirAll(a,0755);e!=nil{return nil,e};r,e:=filepath.EvalSymlinks(a);if e!=nil{return nil,e};return &Resolver{Root:a,RealRoot:r,AllowOutside:allow},nil}
func (r *Resolver) Resolve(p string)(string,error){if p==""{p="."};a:=p;if !filepath.IsAbs(a){a=filepath.Join(r.Root,a)};a=filepath.Clean(a);if r.AllowOutside{return a,nil};real,e:=realAllowMissing(a);if e!=nil{return "",e};rel,e:=filepath.Rel(r.RealRoot,real);if e!=nil{return "",e};if rel==".."||strings.HasPrefix(rel,".."+string(filepath.Separator))||filepath.IsAbs(rel){return "",fmt.Errorf("path is outside the allowed directory (%s): %s",r.Root,a)};return real,nil}
func realAllowMissing(p string)(string,error){cur:=p;var tail []string;for{v,e:=filepath.EvalSymlinks(cur);if e==nil{for i:=len(tail)-1;i>=0;i--{v=filepath.Join(v,tail[i])};return filepath.Clean(v),nil};if !os.IsNotExist(e){return "",e};if info,le:=os.Lstat(cur);le==nil&&info.Mode()&os.ModeSymlink!=0{return "",fmt.Errorf("cannot safely resolve dangling symlink: %s",cur)};parent:=filepath.Dir(cur);if parent==cur{return "",e};tail=append(tail,filepath.Base(cur));cur=parent}}

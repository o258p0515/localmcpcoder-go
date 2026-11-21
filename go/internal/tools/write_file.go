package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)
func (r *Registry) write(_ context.Context,a map[string]any) Result {p,e:=r.path(a,"file_path");if e!=nil{return fail(e.Error())};if e=os.MkdirAll(filepath.Dir(p),0755);e!=nil{return fail(e.Error())};_,e=os.Stat(p);ex:=e==nil;if e=os.WriteFile(p,[]byte(val(a,"content")),0644);e!=nil{return fail(e.Error())};verb:="Created";if ex{verb="Overwrote"};lines:=len(strings.Split(strings.ReplaceAll(val(a,"content"),"\r\n","\n"),"\n"));return ok(fmt.Sprintf("%s: %s (%d lines)",verb,p,lines))}

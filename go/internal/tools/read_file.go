package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
)
func (r *Registry) read(_ context.Context,a map[string]any) Result {p,e:=r.path(a,"file_path");if e!=nil{return fail(e.Error())};b,e:=os.ReadFile(p);if e!=nil{return fail(e.Error())};lines:=strings.Split(strings.ReplaceAll(string(b),"\r\n","\n"),"\n");start:=integer(a,"offset",1)-1;if start<0{start=0};limit:=integer(a,"limit",2000);if limit<1{limit=2000};if limit>5000{limit=5000};end:=start+limit;if end>len(lines){end=len(lines)};var out strings.Builder;for i:=start;i<end;i++{fmt.Fprintf(&out,"%5d\t%s\n",i+1,lines[i])};if end<len(lines){fmt.Fprintf(&out,"\n... [%d more lines, use offset=%d]",len(lines)-end,end+1)};return ok(strings.TrimRight(out.String(),"\n"))}

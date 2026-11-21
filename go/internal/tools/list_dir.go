package tools

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
)
func (r *Registry) list(_ context.Context,a map[string]any) Result {p,e:=r.path(a,"dir_path");if e!=nil{return fail(e.Error())};ents,e:=os.ReadDir(p);if e!=nil{return fail(e.Error())};if len(ents)==0{return ok(p+" (empty)")};var rows []string;for _,x:=range ents{if x.IsDir(){rows=append(rows,"  dir   "+x.Name()+"/")}else{st,er:=x.Info();size:="";if er==nil{size=fmt.Sprintf("  (%d bytes)",st.Size())};rows=append(rows,"  file  "+x.Name()+size)}};sort.Strings(rows);return ok(p+"\n"+strings.Join(rows,"\n"))}

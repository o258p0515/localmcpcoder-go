package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
)
func (r *Registry) edit(_ context.Context,a map[string]any) Result {p,e:=r.path(a,"file_path");if e!=nil{return fail(e.Error())};b,e:=os.ReadFile(p);if e!=nil{return fail(e.Error())};old:=val(a,"old_string");if old==""{return fail("old_string must not be empty")};s:=string(b);n:=strings.Count(s,old);all,_:=a["replace_all"].(bool);if n==0||(!all&&n!=1){if n==0{return fail("old_string was not found in the file.")};return fail(fmt.Sprintf("old_string appears %d times. Add more context or pass replace_all: true.",n))};if all{s=strings.ReplaceAll(s,old,val(a,"new_string"))}else{s=strings.Replace(s,old,val(a,"new_string"),1)};if e=os.WriteFile(p,[]byte(s),0644);e!=nil{return fail(e.Error())};replaced:=1;if all{replaced=n};return ok(fmt.Sprintf("Edited %s (%d replacement(s))",p,replaced))}

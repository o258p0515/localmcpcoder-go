package tools

import (
	"context"
	"fmt"
	"strings"
)
type todoItem struct { Content string; Status string }
var todoIcons = map[string]string{"pending":"[ ]","in_progress":"[~]","completed":"[x]"}
func (r *Registry) todoWrite(_ context.Context,a map[string]any) Result {
 raw,valid:=a["todos"].([]any);if !valid{return fail("todos must be an array")};next:=make([]todoItem,0,len(raw));rows:=make([]string,0,len(raw))
 for _,v:=range raw{m,valid:=v.(map[string]any);if !valid{return fail("each todo must be an object")};content,_:=m["content"].(string);status,_:=m["status"].(string);if _,ok:=todoIcons[status];!ok{return fail("todo status must be pending, in_progress, or completed")};next=append(next,todoItem{content,status});rows=append(rows,fmt.Sprintf("%s %s",todoIcons[status],content))}
 r.todoMu.Lock();r.todos=next;r.todoMu.Unlock();if len(rows)==0{return ok("(empty)")};return ok(strings.Join(rows,"\n"))
}
func (r *Registry) todoRead(_ context.Context,_ map[string]any) Result {r.todoMu.RLock();todos:=append([]todoItem(nil),r.todos...);r.todoMu.RUnlock();if len(todos)==0{return ok("(no tasks)")};rows:=make([]string,0,len(todos));for _,t:=range todos{rows=append(rows,fmt.Sprintf("%s %s",todoIcons[t.Status],t.Content))};return ok(strings.Join(rows,"\n"))}

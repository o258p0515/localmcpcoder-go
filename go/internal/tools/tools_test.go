package tools

import (
	"context"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)
func registry(t *testing.T)*Registry{t.Helper();root:=t.TempDir();f,e:=fsx.New(root,false);if e!=nil{t.Fatal(e)};return New(Deps{FS:f,Root:root,Shell:"bash",MaxOutput:60000})}
func TestEditFileUniqueMatch(t *testing.T){r:=registry(t);p:=filepath.Join(r.D.Root,"a.txt");os.WriteFile(p,[]byte("one\ntwo\none\n"),0600);res:=r.Call(context.Background(),"edit_file",map[string]any{"file_path":"a.txt","old_string":"one","new_string":"x"});if !res.IsError||!strings.Contains(res.Content[0]["text"],"appears 2 times"){t.Fatalf("duplicate replacement should fail: %#v",res)};res=r.Call(context.Background(),"edit_file",map[string]any{"file_path":"a.txt","old_string":"one","new_string":"x","replace_all":true});if res.IsError{t.Fatal(res)};b,_:=os.ReadFile(p);if string(b)!="x\ntwo\nx\n"{t.Fatalf("unexpected edit: %q",b)}}
func TestBashTimeoutAndSecretScrub(t *testing.T){if runtime.GOOS=="windows"{t.Skip("bash-specific test")};r:=registry(t);t.Setenv("MCP_TOKEN","do-not-leak");start:=time.Now();res:=r.Call(context.Background(),"bash",map[string]any{"command":"sleep 5","timeout_ms":float64(1000)});if !strings.Contains(res.Content[0]["text"],"timed out"){t.Fatalf("timeout missing: %s",res.Content[0]["text"])};if time.Since(start)>4*time.Second{t.Fatal("process was not killed promptly")};res=r.Call(context.Background(),"bash",map[string]any{"command":"printenv MCP_TOKEN || true"});if strings.Contains(res.Content[0]["text"],"do-not-leak"){t.Fatal("secret leaked to child")}}
type customInput struct{Name string `json:"name" description:"The name"`;Count int `json:"count,omitempty"`}
func TestGenericAddDerivesSchemaAndGuardsErrors(t *testing.T){r:=registry(t);Add[customInput](r,Spec{Name:"typed",Description:"typed extension"},func(_ context.Context,_ Deps,in customInput)(Result,error){if in.Name=="bad"{return Result{},os.ErrPermission};return ok(in.Name),nil});spec:=r.Items["typed"];props:=spec.InputSchema["properties"].(map[string]any);if props["name"]==nil{t.Fatal("missing generated name property")};required:=spec.InputSchema["required"].([]string);if len(required)!=1||required[0]!="name"{t.Fatalf("required schema incorrect: %#v",required)};res:=r.Call(context.Background(),"typed",map[string]any{"name":"good"});if res.IsError{t.Fatal(res)};res=r.Call(context.Background(),"typed",map[string]any{"name":"bad"});if !res.IsError{t.Fatal("handler error was not returned as isError")}}
func TestTodoStateIsSessionScoped(t *testing.T){r:=registry(t);todos:=[]any{map[string]any{"content":"ship","status":"pending"},map[string]any{"content":"test","status":"in_progress"},map[string]any{"content":"done","status":"completed"}};if v:=r.Call(context.Background(),"todo_write",map[string]any{"todos":todos});v.IsError{t.Fatal(v)};got:=r.Call(context.Background(),"todo_read",map[string]any{}).Content[0]["text"];for _,want:=range []string{"[ ] ship","[~] test","[x] done"}{if !strings.Contains(got,want){t.Fatalf("missing %q in %s",want,got)}};r2:=New(Deps{FS:r.D.FS,Root:r.D.Root,MaxOutput:60000});if got=r2.Call(context.Background(),"todo_read",map[string]any{}).Content[0]["text"];got!="(no tasks)"{t.Fatalf("todo state leaked across sessions: %s",got)}}

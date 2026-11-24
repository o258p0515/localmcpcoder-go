package tools

import (
	"context"
	"fmt"
	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
	"github.com/o258p0515/localmcpcoder-go/go/internal/skills"
	"log"
	"sort"
	"strings"
	"sync"
)

type Deps struct {
	Config    config.Config
	Logger    *log.Logger
	FS        *fsx.Resolver
	Shell     string
	MaxOutput int
	Root      string
	Skills    *skills.Store
	SkillsDir string
}
type Spec struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}
type Result struct {
	Content []map[string]string `json:"content"`
	IsError bool                `json:"isError,omitempty"`
}
type Handler func(context.Context, map[string]any) Result
type Registry struct {
	Items    map[string]Spec
	Handlers map[string]Handler
	D        Deps
	todoMu   sync.RWMutex
	todos    []todoItem
}

func New(d Deps) *Registry {
	r := &Registry{Items: map[string]Spec{}, Handlers: map[string]Handler{}, D: d}
	if d.Config.ToolProfile == "git-executor" {
		r.add("git_execute", "Execute an allowlisted Git operation", "Runs a constrained Git operation. Credentials are fetched internally and never appear in tool arguments or results.", "operation,account", map[string]any{"operation": map[string]any{"type": "string", "enum": []string{"clone", "fetch", "pull", "push", "status", "branch", "log"}}, "account": strProp("RTDB account alias"), "repository": strProp("GitHub HTTPS repository URL (clone only)"), "destination": strProp("Relative destination under the isolated executor root"), "path": strProp("Existing repository path under the isolated executor root"), "ref": strProp("Optional branch or ref")}, r.gitExecute)
		return r
	}
	r.add("bash", "Run a shell command", "Runs a shell command and returns stdout, stderr, and exit code.", "command", map[string]any{"command": strProp("Command to run"), "cwd": strProp("Working directory"), "timeout_ms": numProp("Timeout in milliseconds")}, r.bash)
	r.add("read_file", "Read a file", "Reads a text file with line numbers; use offset and limit for large files.", "file_path", map[string]any{"file_path": strProp("Path"), "offset": numProp("First line (1-based)"), "limit": numProp("Line count")}, r.read)
	r.add("write_file", "Write a file", "Creates or overwrites a file and its parent directories.", "file_path,content", map[string]any{"file_path": strProp("Path"), "content": strProp("Full file content")}, r.write)
	r.add("edit_file", "Edit a file", "Replaces exact text; the match must be unique unless replace_all is true.", "file_path,old_string,new_string", map[string]any{"file_path": strProp("Path"), "old_string": strProp("Exact text to replace"), "new_string": strProp("Replacement text"), "replace_all": map[string]any{"type": "boolean"}}, r.edit)
	r.add("list_dir", "List a directory", "Lists entries in a directory.", "", map[string]any{"dir_path": strProp("Directory (defaults to root)")}, r.list)
	r.add("glob", "Find files", "Finds files by recursive glob pattern and sorts by modification time.", "pattern", map[string]any{"pattern": strProp("Glob pattern"), "dir_path": strProp("Base directory")}, r.glob)
	r.add("grep", "Search file contents", "Searches text files with a Go RE2 regular expression.", "pattern", map[string]any{"pattern": strProp("Go regular expression"), "dir_path": strProp("Starting directory"), "glob": strProp("Filename filter"), "case_insensitive": map[string]any{"type": "boolean"}, "max_results": numProp("Maximum results")}, r.grep)
	r.add("todo_write", "Replace task list", "Saves or replaces the session task list.", "todos", map[string]any{"todos": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"content": strProp("Task description"), "status": map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed"}}}, "required": []string{"content", "status"}}}}, r.todoWrite)
	r.add("todo_read", "Read task list", "Reads the session task list.", "", map[string]any{}, r.todoRead)
	r.add("system_info", "Show system information", "Returns OS, architecture, hostname, root, and shell.", "", map[string]any{}, r.sys)
	r.add("skills_list", "List available skills", "Lists skill names, descriptions, and sources.", "", map[string]any{}, r.skillsList)
	r.add("skill_read", "Read a skill", "Reads a skill body or an extra file inside a user skill folder.", "name", map[string]any{"name": strProp("Skill name"), "file": strProp("Optional file inside the skill folder")}, r.skillRead)
	r.add("skills_reload", "Reload user skills", "Reloads built-in and user skills from disk.", "", map[string]any{}, r.skillsReload)
	return r
}
func makeSchema(p map[string]any, required string) map[string]any {
	x := map[string]any{"type": "object", "properties": p}
	if required != "" {
		fields := strings.Split(required, ",")
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		x["required"] = fields
	}
	return x
}
func strProp(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
func numProp(d string) map[string]any { return map[string]any{"type": "integer", "description": d} }
func (r *Registry) add(n, t, description, required string, p map[string]any, h Handler) {
	spec := Spec{Name: n, Title: t, Description: description, InputSchema: makeSchema(p, required)}
	Add[map[string]any](r, spec, func(ctx context.Context, _ Deps, in map[string]any) (Result, error) { return h(ctx, in), nil })
}
func (r *Registry) List() []Spec {
	v := make([]Spec, 0, len(r.Items))
	for _, s := range r.Items {
		v = append(v, s)
	}
	sort.Slice(v, func(i, j int) bool { return v[i].Name < v[j].Name })
	return v
}
func (r *Registry) Call(ctx context.Context, n string, a map[string]any) Result {
	h, ok := r.Handlers[n]
	if !ok {
		return fail("unknown tool: " + n)
	}
	res := h(ctx, a)
	for i := range res.Content {
		res.Content[i]["text"] = r.clamp(res.Content[i]["text"])
	}
	return res
}
func ok(s string) Result   { return Result{Content: []map[string]string{{"type": "text", "text": s}}} }
func fail(s string) Result { x := ok("Error: " + s); x.IsError = true; return x }
func (r *Registry) clamp(s string) string {
	runes := []rune(s)
	if len(runes) <= r.D.MaxOutput {
		return s
	}
	return string(runes[:r.D.MaxOutput]) + fmt.Sprintf("\n... [output truncated, %d characters omitted]", len(runes)-r.D.MaxOutput)
}
func val(a map[string]any, k string) string { s, _ := a[k].(string); return s }
func integer(a map[string]any, k string, d int) int {
	v, ok := a[k].(float64)
	if !ok {
		return d
	}
	return int(v)
}
func (r *Registry) path(a map[string]any, k string) (string, error) { return r.D.FS.Resolve(val(a, k)) }

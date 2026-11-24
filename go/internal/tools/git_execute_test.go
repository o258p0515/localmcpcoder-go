package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/o258p0515/localmcpcoder-go/go/internal/config"
	"github.com/o258p0515/localmcpcoder-go/go/internal/fsx"
)

func gitProfileRegistry(t *testing.T) *Registry {
	t.Helper()
	root := t.TempDir()
	resolver, e := fsx.New(root, false)
	if e != nil {
		t.Fatal(e)
	}
	return New(Deps{Config: config.Config{ToolProfile: "git-executor", GitCredentialURL: "https://proxy.example.test/internal/runner/git-credential"}, FS: resolver, Root: root, MaxOutput: 4096})
}
func TestGitExecutorProfileRegistersOnlyGitExecute(t *testing.T) {
	r := gitProfileRegistry(t)
	items := r.List()
	if len(items) != 1 || items[0].Name != "git_execute" {
		t.Fatalf("unexpected tools: %#v", items)
	}
}

func TestGitExecutorSchemaHasNoCredentialFields(t *testing.T) {
	items := gitProfileRegistry(t).List()
	if len(items) != 1 {
		t.Fatalf("unexpected tool count: %d", len(items))
	}
	props, ok := items[0].InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatal("missing tool properties")
	}
	for _, forbidden := range []string{"token", "credential", "password", "access_token"} {
		if _, exists := props[forbidden]; exists {
			t.Fatalf("credential field %q leaked into schema", forbidden)
		}
	}
	ops, ok := props["operation"].(map[string]any)["enum"].([]string)
	if !ok {
		t.Fatal("missing operation allowlist")
	}
	foundCommit := false
	for _, op := range ops {
		if op == "commit" {
			foundCommit = true
		}
	}
	if !foundCommit {
		t.Fatal("commit operation missing from schema")
	}
	foundCheckout := false
	for _, op := range ops {
		if op == "checkout" {
			foundCheckout = true
		}
	}
	if !foundCheckout {
		t.Fatal("checkout operation missing from schema")
	}
	if _, ok := props["dry_run"]; !ok {
		t.Fatal("dry_run option missing from schema")
	}
}
func TestGitExecuteRejectsUntrustedRepositoryURLBeforeCredentialRequest(t *testing.T) {
	r := gitProfileRegistry(t)
	res := r.Call(context.Background(), "git_execute", map[string]any{"operation": "clone", "account": "personal", "repository": "https://attacker.example/owner/repo.git", "destination": "repo"})
	if !res.IsError {
		t.Fatal("expected URL validation error")
	}
}
func TestGitExecuteRejectsPathTraversalBeforeCredentialRequest(t *testing.T) {
	r := gitProfileRegistry(t)
	res := r.Call(context.Background(), "git_execute", map[string]any{"operation": "clone", "account": "personal", "repository": "https://github.com/owner/repo.git", "destination": "../outside"})
	if !res.IsError {
		t.Fatal("expected path traversal error")
	}
}
func TestGitExecuteRejectsMissingExecutorTokenWithoutLeakingSecrets(t *testing.T) {
	oldToken := os.Getenv("GIT_EXECUTOR_TOKEN")
	_ = os.Unsetenv("GIT_EXECUTOR_TOKEN")
	defer os.Setenv("GIT_EXECUTOR_TOKEN", oldToken)
	r := gitProfileRegistry(t)
	res := r.Call(context.Background(), "git_execute", map[string]any{"operation": "clone", "account": "personal", "repository": "https://github.com/owner/repo.git", "destination": "repo"})
	if !res.IsError {
		t.Fatal("expected executor-token failure")
	}
	if got := res.Content[0]["text"]; got != "Error: Git credential provider unavailable: dedicated Git executor token is not configured" {
		t.Fatalf("unexpected error: %s", got)
	}
}
func TestWithinRoot(t *testing.T) {
	root := t.TempDir()
	if !withinRoot(root, filepath.Join(root, "repo")) {
		t.Fatal("expected child path inside root")
	}
	if withinRoot(root, filepath.Join(root, "..", "outside")) {
		t.Fatal("accepted traversal")
	}
}

func TestValidBranchRefRejectsOptionAndTraversalSyntax(t *testing.T) {
	for _, ref := range []string{"--upload-pack=evil", "../main", "feature//test", "feature/.hidden", "main.lock", "feature/", "a..b"} {
		if validBranchRef(ref) {
			t.Errorf("accepted unsafe ref %q", ref)
		}
	}
	if !validBranchRef("feature/issue-23") {
		t.Fatal("rejected valid branch")
	}
}

func TestSafeExistingPathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if safeExistingPath(root, link) {
		t.Fatal("accepted symlink escape")
	}
}

func TestValidGitHubRemoteRejectsDifferentPushURL(t *testing.T) {
	gitDir, workTree := filepath.Join(t.TempDir(), "private.git"), t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "--bare", gitDir)
	run("--git-dir="+gitDir, "remote", "add", "origin", "https://github.com/owner/repo.git")
	run("--git-dir="+gitDir, "remote", "set-url", "--push", "origin", "https://attacker.example/owner/repo.git")
	if !validGitHubRemote(gitDir, workTree, false) {
		t.Fatal("expected valid fetch URL")
	}
	if validGitHubRemote(gitDir, workTree, true) {
		t.Fatal("accepted attacker push URL")
	}
}

func TestPrivateGitDirIsOutsideSharedWorkspaceAndPrivate(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(root, "repo")
	gitDir, err := privateGitDir(path)
	if err != nil {
		t.Fatal(err)
	}
	if withinRoot(root, gitDir) {
		t.Fatal("Git metadata is inside the Agent shared workspace")
	}
	base := filepath.Dir(gitDir)
	info, err := os.Stat(base)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatalf("private Git metadata directory permissions too broad: %o", info.Mode().Perm())
	}
}

func TestGitExecuteRejectsGitMetadataInSharedWorkspace(t *testing.T) {
	r := gitProfileRegistry(t)
	path := filepath.Join(r.D.Root, "repo")
	if err := os.MkdirAll(filepath.Join(path, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	res := r.Call(context.Background(), "git_execute", map[string]any{"operation": "status", "account": "personal", "path": "repo"})
	if !res.IsError {
		t.Fatal("accepted Agent-controlled .git metadata")
	}
}

func TestGitOutputRedactsCredentialOnErrorAndSuccess(t *testing.T) {
	secret := "github_pat_sensitive_example"
	got := redactCredential("fatal: remote rejected token="+secret+" url="+url.QueryEscape(secret)+" b64="+base64.StdEncoding.EncodeToString([]byte(secret)), secret)
	if strings.Contains(got, secret) || !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("credential not redacted: %s", got)
	}
}

func TestGitSafeEnvUsesMinimalAllowlist(t *testing.T) {
	env := gitSafeEnv([]string{
		"PATH=/usr/bin",
		"GIT_EXECUTOR_TOKEN=must-not-reach-git",
		"MCP_TOKEN=also-private",
		"HTTP_PROXY=http://proxy.invalid",
		"http_proxy=http://lower-proxy.invalid",
		"https_proxy=http://lower-proxy.invalid",
		"NO_PROXY=localhost",
		"AWS_SECRET_ACCESS_KEY=must-not-reach-git",
		"HOME=/home/mcp-git",
		"LANG=C.UTF-8",
	})
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"GIT_EXECUTOR_TOKEN=", "MCP_TOKEN=", "HTTP_PROXY=", "http_proxy=", "https_proxy=", "NO_PROXY=", "AWS_SECRET_ACCESS_KEY="} {
		if strings.Contains(joined, forbidden) { t.Fatalf("sensitive environment variable leaked: %s", forbidden) }
	}
	if !strings.Contains(joined, "PATH=/usr/bin") || !strings.Contains(joined, "HOME=/home/mcp-git") {
		t.Fatalf("required process environment was removed: %q", joined)
	}
}

func TestWriteAskpassDoesNotPersistCredentials(t *testing.T) {
	script, clean, err := writeAskpass()
	if err != nil { t.Fatal(err) }
	dir := filepath.Dir(script)
	defer clean()
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("askpass directory must be private: info=%v err=%v", info, err)
	}
	if info, err := os.Stat(script); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("askpass helper must be private and executable: info=%v err=%v", info, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil { t.Fatal(err) }
	if len(entries) != 1 || entries[0].Name() != "askpass" {
		t.Fatalf("askpass directory contains unexpected files: %v", entries)
	}
	body, err := os.ReadFile(script)
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(body), "credential") || strings.Contains(string(body), "ghp_") {
		t.Fatalf("askpass helper unexpectedly contains a credential: %q", body)
	}
}

func TestGitSubcommandsWorkWhenInheritedCwdIsInaccessible(t *testing.T) {
	oldwd, err := os.Getwd()
	if err != nil { t.Fatal(err) }
	defer func() { _ = os.Chdir(oldwd) }()

	base := t.TempDir()
	gitDir := filepath.Join(base, "private.git")
	init := exec.Command("git", "init", "--bare", gitDir)
	if out, err := init.CombinedOutput(); err != nil { t.Fatalf("init bare repo: %v: %s", err, out) }
	workTree := filepath.Join(base, "work")
	if err := os.Mkdir(workTree, 0700); err != nil { t.Fatal(err) }
	remote := exec.Command("git", "--git-dir="+gitDir, "remote", "add", "origin", "https://github.com/owner/repo.git")
	if out, err := remote.CombinedOutput(); err != nil { t.Fatalf("add remote: %v: %s", err, out) }

	badCwd := filepath.Join(base, "removed-cwd")
	if err := os.Mkdir(badCwd, 0700); err != nil { t.Fatal(err) }
	if err := os.Chdir(badCwd); err != nil { t.Fatal(err) }
	if err := os.Remove(badCwd); err != nil { t.Fatal(err) }

	if !validBranchRef("main") { t.Fatal("branch validation failed with inaccessible inherited cwd") }
	if !validGitHubRemote(gitDir, workTree, false) { t.Fatal("remote validation failed with inaccessible inherited cwd") }
	got, err := runSimpleGit(context.Background(), gitDir, "", os.TempDir(), "rev-parse", "--is-bare-repository")
	if err != nil || strings.TrimSpace(got) != "true" { t.Fatalf("runSimpleGit failed: output=%q err=%v", got, err) }
}

func TestGitBaseArgsPreservesSystemCertificateAuthorities(t *testing.T) {
	args := strings.Join(gitBaseArgs(t.TempDir()), " ")
	if strings.Contains(args, "sslCAInfo") {
		t.Fatalf("Git base args must not override system CA bundle: %s", args)
	}
	if !strings.Contains(args, "http.sslVerify=true") {
		t.Fatalf("TLS verification must remain enabled: %s", args)
	}
}

func TestMakeSharedWorkspaceGroupWritable(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil { t.Fatal(err) }
	file := filepath.Join(nested, "agent-created.txt")
	if err := os.WriteFile(file, []byte("shared"), 0600); err != nil { t.Fatal(err) }
	if err := makeSharedWorkspaceGroupWritable(root); err != nil { t.Fatal(err) }
	for _, dir := range []string{root, nested} {
		info, err := os.Stat(dir)
		if err != nil { t.Fatal(err) }
		if info.Mode().Perm() != 0770 { t.Fatalf("directory %s must be group-writable; got %v", dir, info.Mode()) }
	}
	info, err := os.Stat(file)
	if err != nil { t.Fatal(err) }
	if info.Mode().Perm()&0060 != 0060 || info.Mode().Perm()&0007 != 0 { t.Fatalf("file must be group-readable/writable and not world-accessible; got %v", info.Mode()) }
}

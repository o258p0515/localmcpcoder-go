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
func TestGitExecuteRejectsMissingOIDCWithoutLeakingSecrets(t *testing.T) {
	oldURL, oldToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	_ = os.Unsetenv("ACTIONS_ID_TOKEN_REQUEST_URL")
	_ = os.Unsetenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	defer os.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", oldURL)
	defer os.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", oldToken)
	r := gitProfileRegistry(t)
	res := r.Call(context.Background(), "git_execute", map[string]any{"operation": "clone", "account": "personal", "repository": "https://github.com/owner/repo.git", "destination": "repo"})
	if !res.IsError {
		t.Fatal("expected OIDC failure")
	}
	if got := res.Content[0]["text"]; got != "Error: Git credential provider unavailable: GitHub Actions OIDC is not available" {
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
	got := redactCredential("fatal: remote rejected token="+secret, secret)
	if strings.Contains(got, secret) || !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("credential not redacted: %s", got)
	}
}

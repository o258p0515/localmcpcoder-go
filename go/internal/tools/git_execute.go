package tools

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type gitCredential struct {
	Username   string `json:"username"`
	Credential string `json:"credential"`
}
var githubRepoRE = regexp.MustCompile("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$")
var accountAliasRE = regexp.MustCompile("^[A-Za-z0-9_.-]{1,64}$")

func (r *Registry) gitExecute(ctx context.Context, a map[string]any) Result {
	op := strings.TrimSpace(val(a, "operation"))
	account := strings.TrimSpace(val(a, "account"))
	allowed := map[string]bool{"clone": true, "fetch": true, "pull": true, "push": true, "status": true, "branch": true, "checkout": true, "log": true, "commit": true}
	if !allowed[op] {
		return fail("unsupported Git operation")
	}
	if !accountAliasRE.MatchString(account) {
		return fail("a valid account alias is required")
	}

	root := r.D.Root
	var repoPath string
	if op == "clone" {
		raw := strings.TrimSpace(val(a, "repository"))
		if !githubRepoRE.MatchString(raw) {
			return fail("repository must be a GitHub HTTPS repository URL")
		}
		dest := strings.TrimSpace(val(a, "destination"))
		if dest == "" || filepath.IsAbs(dest) {
			return fail("clone destination must be a relative path")
		}
		repoPath = filepath.Join(root, filepath.Clean(dest))
		if !withinRoot(root, repoPath) || !safeParentPath(root, filepath.Dir(repoPath)) {
			return fail("destination is outside executor root")
		}
		if _, e := os.Lstat(repoPath); e == nil {
			return fail("destination already exists")
		} else if !os.IsNotExist(e) {
			return fail("cannot inspect destination")
		}
	} else {
		path := strings.TrimSpace(val(a, "path"))
		if path == "" {
			path = "."
		}
		if filepath.IsAbs(path) {
			return fail("repository path must be relative")
		}
		repoPath = filepath.Join(root, filepath.Clean(path))
		if !withinRoot(root, repoPath) || !safeExistingPath(root, repoPath) {
			return fail("repository path is outside executor root")
		}
		info, e := os.Lstat(repoPath)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail("path is not a safe working directory")
		}
		if _, e := os.Lstat(filepath.Join(repoPath, ".git")); e == nil {
			return fail("Git metadata must remain in the private executor store; use git_execute clone")
		} else if !os.IsNotExist(e) {
			return fail("cannot inspect workspace Git metadata")
		}
	}

	lockValue, _ := r.gitLocks.LoadOrStore(repoPath, &sync.Mutex{})
	repoLock := lockValue.(*sync.Mutex)
	repoLock.Lock()
	defer repoLock.Unlock()

	gitDir, err := privateGitDir(repoPath)
	if err != nil {
		return fail("cannot prepare private Git metadata store")
	}
	if op != "clone" && !validPrivateGitDir(gitDir) {
		return fail("no private Git metadata exists for this workspace; clone the repository first")
	}
	credentialRepository := strings.TrimSpace(val(a, "repository"))
	if op == "fetch" || op == "pull" || op == "push" {
		credentialRepository, err = gitHubRemoteURL(gitDir, repoPath, op == "push")
		if err != nil {
			return fail("origin and push URL must be GitHub HTTPS repository URLs")
		}
	}

	ref := strings.TrimSpace(val(a, "ref"))
	if ref != "" && !validBranchRef(ref) {
		return fail("ref must be a valid branch name")
	}
	message := strings.TrimSpace(val(a, "message"))
	if op == "commit" && (message == "" || len(message) > 512 || strings.ContainsRune(message, '\x00')) {
		return fail("commit requires a message of 1 to 512 characters")
	}
	dryRun, _ := a["dry_run"].(bool)
	if op != "commit" && a["paths"] != nil {
		return fail("paths is only supported for commit")
	}
	commitPaths, pathErr := validateGitCommitPaths(repoPath, a["paths"])
	if pathErr != nil {
		return fail(pathErr.Error())
	}

	needsCredential := op == "clone" || op == "fetch" || op == "pull" || op == "push"
	var credential gitCredential
	if needsCredential {
		credential, err = r.fetchGitCredential(ctx, account, op, credentialRepository)
		if err != nil {
			return fail("Git credential provider unavailable: " + err.Error())
		}
		defer func() { credential.Credential = "" }()
	}

	timeout := 180 * time.Second
	if op == "clone" {
		timeout = 300 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	hooksDir, err := os.MkdirTemp("", "localmcp-git-hooks-")
	if err != nil {
		return fail("cannot prepare Git hooks isolation")
	}
	_ = os.Chmod(hooksDir, 0700)
	defer os.RemoveAll(hooksDir)

	args := gitBaseArgs(hooksDir)
	if op == "clone" {
		if err := os.MkdirAll(filepath.Dir(repoPath), 0770); err != nil || !safeExistingPath(root, filepath.Dir(repoPath)) {
			return fail("cannot create a destination parent safely")
		}
		base := filepath.Dir(gitDir)
		if err := os.MkdirAll(base, 0700); err != nil {
			return fail("cannot create private Git metadata store")
		}
		_ = os.Chmod(base, 0700)
		if _, err := os.Lstat(gitDir); err == nil {
			return fail("private Git metadata already exists for this workspace")
		} else if !os.IsNotExist(err) {
			return fail("cannot inspect private Git metadata")
		}
		args = append(args, "clone", "--separate-git-dir="+gitDir, "--", val(a, "repository"), repoPath)
	} else {
		args = append(args, "--git-dir="+gitDir, "--work-tree="+repoPath)
		switch op {
		case "fetch":
			args = append(args, "fetch", "--prune", "origin")
			if ref != "" {
				args = append(args, ref)
			}
		case "pull":
			args = append(args, "pull", "--ff-only", "origin")
			if ref != "" {
				args = append(args, ref)
			}
		case "push":
			if dryRun {
				args = append(args, "push", "--dry-run", "origin")
			} else {
				args = append(args, "push", "origin")
			}
			if ref != "" {
				args = append(args, ref)
			}
		case "status":
			args = append(args, "status", "--short", "--branch")
		case "branch":
			args = append(args, "branch", "--list")
		case "checkout":
			if ref == "" {
				return fail("checkout requires an existing branch ref")
			}
			args = append(args, "checkout", ref)
		case "log":
			args = append(args, "log", "-10", "--oneline", "--decorate")
		case "commit":
			if len(commitPaths) == 0 {
				args = append(args, "add", "-A", "--", ".")
			} else {
				args = append(args, "add", "--")
				args = append(args, commitPaths...)
			}
		}
	}

	cmd := exec.CommandContext(cctx, "git", args...)
	cmd.Dir = root
	cmd.Env = gitSafeEnv(os.Environ())
	if needsCredential {
		askpass, clean, e := writeAskpass()
		if e != nil {
			return fail("cannot prepare temporary Git credential helper")
		}
		defer clean()
		cmd.Env = append(cmd.Env, "GIT_ASKPASS="+askpass, "GIT_TERMINAL_PROMPT=0", "LOCALMCP_GIT_USERNAME="+credential.Username, "LOCALMCP_GIT_CREDENTIAL="+credential.Credential)
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	output, runErr := runGitCommand(cmd, r.D.MaxOutput)
	output = redactCredential(output, credential.Credential)
	if cctx.Err() == context.DeadlineExceeded {
		return fail("Git operation timed out")
	}
	if runErr != nil {
		return gitCommandFailure(runErr, output, credential.Credential)
	}

	if op == "clone" {
		marker := filepath.Join(repoPath, ".git")
		if info, e := os.Lstat(marker); e == nil && info.Mode().IsRegular() {
			if e = os.Remove(marker); e != nil {
				return fail("cloned repository metadata could not be isolated from the shared workspace")
			}
		} else {
			return fail("clone did not create the expected separate Git metadata marker")
		}
		_ = os.Chmod(gitDir, 0700)
		if e := makeSharedWorkspaceGroupWritable(repoPath); e != nil {
			return fail("cannot set shared workspace group permissions")
		}
		if _, e := runSimpleGit(cctx, gitDir, "", hooksDir, "config", "user.name", "LocalMCP Git Executor"); e != nil {
			return fail("cannot configure private Git author identity")
		}
		if _, e := runSimpleGit(cctx, gitDir, "", hooksDir, "config", "user.email", "localmcp-git-executor@users.noreply.github.com"); e != nil {
			return fail("cannot configure private Git author identity")
		}
	}
	if op == "commit" {
		commitArgs := append(gitBaseArgs(hooksDir), "--git-dir="+gitDir, "--work-tree="+repoPath, "commit", "-m", message)
		commitCmd := exec.CommandContext(cctx, "git", commitArgs...)
		commitCmd.Dir = repoPath
		commitCmd.Env = append(gitSafeEnv(os.Environ()), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		commitOutput, commitErr := runGitCommand(commitCmd, r.D.MaxOutput)
		output = strings.TrimSpace(output + "\n" + commitOutput)
		if commitErr != nil {
			return gitCommandFailure(commitErr, output, "")
		}
	}
	if output == "" {
		output = "Git " + op + " completed successfully"
	}
	return ok(output + "\n[exit code: 0]")
}

func validateGitCommitPaths(repoPath string, raw any) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok || len(items) == 0 || len(items) > 100 {
		return nil, errors.New("paths must contain between 1 and 100 relative paths")
	}
	cleaned := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		value, ok := item.(string)
		if !ok || strings.TrimSpace(value) == "" || strings.ContainsRune(value, '\x00') || filepath.IsAbs(value) {
			return nil, errors.New("each commit path must be a non-empty relative path")
		}
		path := filepath.Clean(value)
		rel, err := filepath.Rel(repoPath, filepath.Join(repoPath, path))
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || path == "." && len(items) > 1 {
			return nil, errors.New("commit paths must stay inside the selected repository")
		}
		if path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) || path == ".git" || strings.HasPrefix(path, ".git"+string(filepath.Separator)) {
			return nil, errors.New("commit paths cannot target parent directories or Git metadata")
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		cleaned = append(cleaned, path)
	}
	return cleaned, nil
}

func gitBaseArgs(hooksDir string) []string {
	return []string{"-c", "credential.helper=", "-c", "core.hooksPath=" + hooksDir,
		"-c", "http.extraHeader=", "-c", "http.https://github.com/.extraHeader=",
		"-c", "http.sslVerify=true", "-c", "http.https://github.com/.sslVerify=true",
		"-c", "http.https://github.com/.proxy=",
		"-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "commit.gpgsign=false"}
}

func makeSharedWorkspaceGroupWritable(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil { return err }
		if info.Mode()&os.ModeSymlink != 0 { return nil }
		if info.IsDir() { return os.Chmod(path, 0770|os.ModeSetgid|os.ModeSticky) }
		perms := (info.Mode().Perm() & 0700) | 0060
		if info.Mode().Perm()&0100 != 0 { perms |= 0010 }
		return os.Chmod(path, perms)
	})
}

func privateGitDir(repoPath string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("Git executor home directory unavailable")
	}
	base := filepath.Join(home, ".localmcp-git", "repos")
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", err
	}
	if err := os.Chmod(filepath.Dir(base), 0700); err != nil {
		return "", err
	}
	if err := os.Chmod(base, 0700); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(repoPath))
	return filepath.Join(base, hex.EncodeToString(sum[:])+".git"), nil
}

func validPrivateGitDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&0077 == 0
}

func runSimpleGit(ctx context.Context, gitDir, workTree, hooksDir string, args ...string) (string, error) {
	cmdArgs := gitBaseArgs(hooksDir)
	cmdArgs = append(cmdArgs, "--git-dir="+gitDir)
	if workTree != "" {
		cmdArgs = append(cmdArgs, "--work-tree="+workTree)
	}
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	if workTree != "" { cmd.Dir = workTree } else { cmd.Dir = filepath.Dir(gitDir) }
	cmd.Env = append(gitSafeEnv(os.Environ()), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	return runGitCommand(cmd, 64*1024)
}

func runGitCommand(cmd *exec.Cmd, maxOutput int) (string, error) {
	stdout, stderr := &cappedBuffer{max: maxOutput}, &cappedBuffer{max: maxOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	if value := strings.TrimSpace(stderr.String()); value != "" {
		if output != "" {
			output += "\n"
		}
		output += "[stderr]\n" + value
	}
	return output, err
}

func redactCredential(output, credential string) string {
	if credential == "" {
		return output
	}
	variants := []string{
		credential,
		url.QueryEscape(credential),
		url.PathEscape(credential),
		base64.StdEncoding.EncodeToString([]byte(credential)),
		base64.RawStdEncoding.EncodeToString([]byte(credential)),
		base64.URLEncoding.EncodeToString([]byte(credential)),
		base64.RawURLEncoding.EncodeToString([]byte(credential)),
	}
	for _, variant := range variants {
		if variant != "" {
			output = strings.ReplaceAll(output, variant, "[REDACTED]")
		}
	}
	return output
}

func gitCommandFailure(err error, output, credential string) Result {
	output = redactCredential(output, credential)
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fail(fmt.Sprintf("Git operation failed (exit %d): %s", exit.ExitCode(), output))
	}
	return fail("Git operation failed: " + redactCredential(err.Error(), credential))
}

func (r *Registry) fetchGitCredential(ctx context.Context, account, operation, repository string) (gitCredential, error) {
	executorToken := os.Getenv("GIT_EXECUTOR_TOKEN")
	if len(executorToken) < 32 { return gitCredential{}, errors.New("dedicated Git executor token is not configured") }
	endpoint, err := url.Parse(r.D.Config.GitCredentialURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.Path != "/internal/runner/git-credential" {
		return gitCredential{}, errors.New("invalid credential provider endpoint")
	}
	body, _ := json.Marshal(map[string]string{"account": account, "operation": operation, "repository": repository})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), strings.NewReader(string(body)))
	if err != nil { return gitCredential{}, errors.New("cannot create credential provider request") }
	req.Header.Set("Authorization", "Bearer "+executorToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil { return gitCredential{}, errors.New("credential provider request failed") }
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK { return gitCredential{}, fmt.Errorf("credential provider returned HTTP %d", resp.StatusCode) }
	var cred gitCredential
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&cred); err != nil || cred.Credential == "" {
		return gitCredential{}, errors.New("credential response is invalid")
	}
	return cred, nil
}

func writeAskpass() (string, func(), error) {
	if runtime.GOOS == "windows" {
		return "", nil, errors.New("secure askpass helper is not supported on Windows")
	}
	dir, err := os.MkdirTemp("", "localmcp-git-auth-")
	if err != nil {
		return "", nil, err
	}
	if err = os.Chmod(dir, 0700); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	// The helper contains no secret. The credential is passed only in the
	// isolated Git subprocess environment and never written to the filesystem.
	script := filepath.Join(dir, "askpass")
	body := "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' \"$LOCALMCP_GIT_USERNAME\" ;; *) printf '%s\\n' \"$LOCALMCP_GIT_CREDENTIAL\" ;; esac\n"
	if err = os.WriteFile(script, []byte(body), 0700); err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	return script, func() { _ = os.RemoveAll(dir) }, nil
}

func gitSafeEnv(in []string) []string {
	// Use an explicit allowlist: this also removes lowercase proxy variables,
	// cloud credentials, runtime secrets, and unknown agent/runner environment.
	allowed := map[string]struct{}{
		"PATH": {}, "HOME": {}, "LANG": {}, "LC_ALL": {}, "LC_CTYPE": {},
		"TERM": {}, "TMPDIR": {}, "TMP": {}, "TEMP": {},
		"SYSTEMROOT": {}, "WINDIR": {}, "COMSPEC": {}, "PATHEXT": {},
		"USERPROFILE": {}, "HOMEDRIVE": {}, "HOMEPATH": {},
	}
	out := make([]string, 0, len(allowed))
	for _, value := range in {
		key, _, ok := strings.Cut(value, "=")
		if !ok {
			continue
		}
		if _, keep := allowed[strings.ToUpper(key)]; keep {
			out = append(out, value)
		}
	}
	return out
}

func withinRoot(root, path string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func safeExistingPath(root, path string) bool {
	resolvedRoot, e := filepath.EvalSymlinks(root)
	if e != nil {
		return false
	}
	resolvedPath, e := filepath.EvalSymlinks(path)
	if e != nil {
		return false
	}
	return withinRoot(resolvedRoot, resolvedPath)
}
func safeParentPath(root, path string) bool {
	for {
		if _, e := os.Lstat(path); e == nil {
			return safeExistingPath(root, path)
		} else if !os.IsNotExist(e) {
			return false
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}
func gitHubRemoteURL(gitDir, workTree string, checkPush bool) (string, error) {
	args := append(gitBaseArgs(os.TempDir()), "--git-dir="+gitDir, "--work-tree="+workTree, "remote", "get-url")
	if checkPush {
		args = append(args, "--push")
	}
	args = append(args, "origin")
	cmd := exec.Command("git", args...)
	cmd.Dir = workTree
	cmd.Env = append(gitSafeEnv(os.Environ()), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	remote, err := cmd.Output()
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(remote))
	if !githubRepoRE.MatchString(value) {
		return "", errors.New("origin is not a GitHub HTTPS repository")
	}
	return value, nil
}

func validGitHubRemote(gitDir, workTree string, checkPush bool) bool {
	_, err := gitHubRemoteURL(gitDir, workTree, checkPush)
	return err == nil
}

func validBranchRef(ref string) bool {
	if len(ref) > 128 || strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, "\x00\r\n") || strings.Contains(ref, "..") || strings.Contains(ref, "//") || strings.Contains(ref, "@{") || strings.HasSuffix(ref, "/") || strings.HasSuffix(ref, ".") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	cmd := exec.Command("git", "check-ref-format", "--branch", ref)
	cmd.Dir = os.TempDir()
	return cmd.Run() == nil
}

package tools

import (
	"context"
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
	"time"
)

type gitCredential struct {
	Username   string `json:"username"`
	Credential string `json:"credential"`
}
type oidcTokenResponse struct {
	Value string `json:"value"`
}

var githubRepoRE = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$`)

func (r *Registry) gitExecute(ctx context.Context, a map[string]any) Result {
	op, account := strings.TrimSpace(val(a, "operation")), strings.TrimSpace(val(a, "account"))
	if !map[string]bool{"clone": true, "fetch": true, "pull": true, "push": true, "status": true, "branch": true, "log": true}[op] {
		return fail("unsupported Git operation")
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`).MatchString(account) {
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
		if !withinRoot(root, repoPath) {
			return fail("destination is outside executor root")
		}
		if _, e := os.Lstat(repoPath); e == nil {
			return fail("destination already exists")
		} else if !os.IsNotExist(e) {
			return fail("cannot inspect destination")
		}
		if !safeParentPath(root, filepath.Dir(repoPath)) {
			return fail("destination parent resolves outside executor root")
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
		if !withinRoot(root, repoPath) {
			return fail("repository path is outside executor root")
		}
		if fi, e := os.Stat(filepath.Join(repoPath, ".git")); e != nil || (!fi.IsDir() && !fi.Mode().IsRegular()) {
			return fail("path is not a Git working tree")
		}
		if !safeExistingPath(root, repoPath) {
			return fail("repository path resolves outside executor root")
		}
		if !validGitHubRemote(repoPath, op == "push") {
			return fail("origin and push URL must be GitHub HTTPS repository URLs without embedded credentials")
		}
	}
	ref := strings.TrimSpace(val(a, "ref"))
	if ref != "" && !validBranchRef(ref) {
		return fail("ref must be a valid branch name")
	}
	needsCredential := op == "clone" || op == "fetch" || op == "pull" || op == "push"
	var credential gitCredential
	if needsCredential {
		c, e := r.fetchGitCredential(ctx, account, op)
		if e != nil {
			return fail("Git credential provider unavailable: " + e.Error())
		}
		credential = c
		defer func() { credential.Credential = "" }()
	}
	timeout := 180 * time.Second
	if op == "clone" {
		timeout = 300 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	hooksDir, e := os.MkdirTemp("", "localmcp-git-hooks-")
	if e != nil {
		return fail("cannot prepare Git hooks isolation")
	}
	_ = os.Chmod(hooksDir, 0700)
	defer os.RemoveAll(hooksDir)
	args := []string{"-c", "credential.helper=", "-c", "core.hooksPath=" + hooksDir, "-c", "http.extraHeader=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"}
	switch op {
	case "clone":
		args = append(args, "clone", "--", val(a, "repository"), repoPath)
	case "fetch":
		args = append(args, "-C", repoPath, "fetch", "--prune", "origin")
		if ref != "" {
			args = append(args, ref)
		}
	case "pull":
		args = append(args, "-C", repoPath, "pull", "--ff-only")
		if ref != "" {
			args = append(args, "origin", ref)
		}
	case "push":
		args = append(args, "-C", repoPath, "push", "origin")
		if ref != "" {
			args = append(args, ref)
		}
	case "status":
		args = append(args, "-C", repoPath, "status", "--short", "--branch")
	case "branch":
		args = append(args, "-C", repoPath, "branch", "--list")
	case "log":
		args = append(args, "-C", repoPath, "log", "-10", "--oneline", "--decorate")
	}
	cmd := exec.CommandContext(cctx, "git", args...)
	if op == "clone" {
		if e := os.MkdirAll(filepath.Dir(repoPath), 0700); e != nil || !safeExistingPath(root, filepath.Dir(repoPath)) {
			return fail("cannot create a destination parent safely")
		}
	}
	cmd.Env = gitSafeEnv(os.Environ())
	var cleanup func()
	if needsCredential {
		askpass, clean, e := writeAskpass(credential)
		if e != nil {
			return fail("cannot prepare temporary Git credential helper")
		}
		cleanup = clean
		defer cleanup()
		cmd.Env = append(cmd.Env, "GIT_ASKPASS="+askpass, "GIT_TERMINAL_PROMPT=0")
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	stdout, stderr := &cappedBuffer{max: r.D.MaxOutput}, &cappedBuffer{max: r.D.MaxOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	if e := strings.TrimSpace(stderr.String()); e != "" {
		if output != "" {
			output += "\n"
		}
		output += "[stderr]\n" + e
	}
	if credential.Credential != "" {
		output = strings.ReplaceAll(output, credential.Credential, "[REDACTED]")
	}
	if cctx.Err() == context.DeadlineExceeded {
		return fail("Git operation timed out")
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fail(fmt.Sprintf("Git operation failed (exit %d): %s", exit.ExitCode(), output))
		}
		return fail("Git operation failed: " + err.Error())
	}
	if output == "" {
		output = "Git " + op + " completed successfully"
	}
	return ok(output + "\n[exit code: 0]")
}

func (r *Registry) fetchGitCredential(ctx context.Context, account, operation string) (gitCredential, error) {
	requestURL, requestToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if requestURL == "" || requestToken == "" {
		return gitCredential{}, errors.New("GitHub Actions OIDC is not available")
	}
	u, e := url.Parse(requestURL)
	if e != nil {
		return gitCredential{}, errors.New("invalid OIDC request URL")
	}
	q := u.Query()
	q.Set("audience", "localmcpcoder-git-credential")
	u.RawQuery = q.Encode()
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return gitCredential{}, e
	}
	req.Header.Set("Authorization", "Bearer "+requestToken)
	client := http.Client{Timeout: 15 * time.Second}
	resp, e := client.Do(req)
	if e != nil {
		return gitCredential{}, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return gitCredential{}, fmt.Errorf("OIDC token request returned HTTP %d", resp.StatusCode)
	}
	var oidc oidcTokenResponse
	if e = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&oidc); e != nil || oidc.Value == "" {
		return gitCredential{}, errors.New("invalid OIDC token response")
	}
	body, _ := json.Marshal(map[string]string{"account": account, "operation": operation})
	req, e = http.NewRequestWithContext(ctx, http.MethodPost, r.D.Config.GitCredentialURL, strings.NewReader(string(body)))
	if e != nil {
		return gitCredential{}, e
	}
	req.Header.Set("Authorization", "Bearer "+oidc.Value)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, e = client.Do(req)
	if e != nil {
		return gitCredential{}, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return gitCredential{}, fmt.Errorf("credential provider returned HTTP %d", resp.StatusCode)
	}
	var cred gitCredential
	if e = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&cred); e != nil || cred.Credential == "" {
		return gitCredential{}, errors.New("credential response is invalid")
	}
	return cred, nil
}
func writeAskpass(c gitCredential) (string, func(), error) {
	dir, e := os.MkdirTemp("", "localmcp-git-auth-")
	if e != nil {
		return "", nil, e
	}
	if e = os.Chmod(dir, 0700); e != nil {
		os.RemoveAll(dir)
		return "", nil, e
	}
	secret := filepath.Join(dir, "credential")
	payload := c.Username + "\n" + c.Credential + "\n"
	if e = os.WriteFile(secret, []byte(payload), 0600); e != nil {
		os.RemoveAll(dir)
		return "", nil, e
	}
	script := filepath.Join(dir, "askpass")
	body := "#!/bin/sh\ncase \"$1\" in *Username*) sed -n '1p' \"" + secret + "\" ;; *) sed -n '2p' \"" + secret + "\" ;; esac\n"
	if runtime.GOOS == "windows" {
		os.RemoveAll(dir)
		return "", nil, errors.New("secure askpass helper is not supported on Windows")
	}
	if e = os.WriteFile(script, []byte(body), 0700); e != nil {
		os.RemoveAll(dir)
		return "", nil, e
	}
	return script, func() { _ = os.RemoveAll(dir) }, nil
}
func gitSafeEnv(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		k := strings.SplitN(v, "=", 2)[0]
		if strings.HasPrefix(k, "GIT_") || strings.HasPrefix(k, "ACTIONS_ID_TOKEN_") {
			continue
		}
		switch k {
		case "MCP_TOKEN", "MCP_OAUTH_CLIENT_SECRET", "HUB_URLS", "CF_API_TOKEN", "TS_AUTHKEY":
			continue
		}
		out = append(out, v)
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
func validGitHubRemote(path string, checkPush bool) bool {
	args := []string{"-C", path, "remote", "get-url"}
	if checkPush {
		args = append(args, "--push")
	}
	args = append(args, "origin")
	remote, err := exec.Command("git", args...).Output()
	return err == nil && githubRepoRE.MatchString(strings.TrimSpace(string(remote)))
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
	return exec.Command("git", "check-ref-format", "--branch", ref).Run() == nil
}

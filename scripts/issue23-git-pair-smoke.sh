#!/usr/bin/env bash
set -Eeuo pipefail
CURRENT_CHECKPOINT="initialization"
trap 'status=$?; printf "::error title=Issue23 smoke failure::checkpoint=%s line=%s exit=%s\\n" "$CURRENT_CHECKPOINT" "${BASH_LINENO[0]:-$LINENO}" "$status"; exit "$status"' ERR
checkpoint() { CURRENT_CHECKPOINT="$1"; echo "::notice title=Issue23 smoke checkpoint::$CURRENT_CHECKPOINT"; }
checkpoint "validate-required-environment"
test -n "$MCP_TOKEN"
test -n "$GIT_CREDENTIAL_URL"
test -n "$GIT_EXECUTOR_TOKEN"
test -n "$RUNNER_TEMP"
BIN="/tmp/localmcpcoder-git-executor-$GITHUB_RUN_ID"
ROOT="/tmp/issue23-shared-workspace-$GITHUB_RUN_ID"
AGENT_LOG="$RUNNER_TEMP/issue23-agent-smoke.log"
GIT_LOG="$RUNNER_TEMP/issue23-git-smoke.log"
AGENT_PID=""
GIT_PID=""
cleanup() {
  set +e
  if [ -n "$AGENT_PID" ]; then sudo kill "$AGENT_PID" 2>/dev/null; fi
  if [ -n "$GIT_PID" ]; then sudo kill "$GIT_PID" 2>/dev/null; fi
  sudo pkill -u mcp-agent -f "$BIN" 2>/dev/null
  sudo pkill -u mcp-git -f "$BIN" 2>/dev/null
  sudo pkill -u mcp-git -f '^sleep 90$' 2>/dev/null
  sudo rm -rf /tmp/issue23-git-private
}
trap cleanup EXIT
checkpoint "install-executor-binary-and-create-isolated-users"
sudo install -m 0755 "$RUNNER_TEMP/localmcpcoder-git-executor" "$BIN"
sudo groupadd --system mcp-workspace 2>/dev/null || true
sudo useradd --system --create-home --home-dir /home/mcp-agent --shell /usr/sbin/nologin mcp-agent 2>/dev/null || true
sudo useradd --system --create-home --home-dir /home/mcp-git --shell /usr/sbin/nologin mcp-git 2>/dev/null || true
sudo usermod -aG mcp-workspace mcp-agent
sudo usermod -aG mcp-workspace mcp-git
sudo install -d -o "$(id -un)" -g mcp-workspace -m 2770 "$ROOT"
printf 'MCP_SHARED_ROOT=%s\\n' "$ROOT" >> "$GITHUB_ENV"
umask 0002
checkpoint "start-agent-and-git-mcp-servers"
sudo -H --preserve-env=MCP_TOKEN -u mcp-agent bash -c 'umask 0002; exec "$@"' _ "$BIN" --root "$ROOT" --port 8787 --tunnel none >"$AGENT_LOG" 2>&1 &
AGENT_PID=$!
sudo -H --preserve-env=MCP_TOKEN,GIT_CREDENTIAL_URL,GIT_EXECUTOR_TOKEN -u mcp-git bash -c 'umask 0002; exec "$@"' _ "$BIN" --root "$ROOT" --port 8788 --tunnel none --tool-profile git-executor >"$GIT_LOG" 2>&1 &
GIT_PID=$!
wait_http() {
  local port="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "MCP server on port $port did not become healthy" >&2
  return 1
}
checkpoint "wait-for-agent-and-git-health"
wait_http 8787
wait_http 8788
mcp_call() {
  local port="$1" payload="$2"
  curl -sS --max-time 330 "http://127.0.0.1:$port/mcp" \
    -H "Authorization: Bearer $MCP_TOKEN" \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    --data "$payload"
}
checkpoint "verify-agent-and-git-tool-catalogs"
AGENT_TOOLS="$(mcp_call 8787 '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
GIT_TOOLS="$(mcp_call 8788 '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
jq -e '.result.tools | (map(.name) | index("bash") != null and index("git_execute") == null)' <<<"$AGENT_TOOLS" >/dev/null
jq -e '.result.tools | (length == 1 and .[0].name == "git_execute" and ((.[0].inputSchema.properties // {}) | has("token") | not) and ((.[0].inputSchema.properties // {}) | has("credential") | not) and ((.[0].inputSchema.properties // {}) | has("message")) and ((.[0].inputSchema.properties // {}) | has("dry_run")) and ((.[0].inputSchema.properties.operation.enum | index("commit")) != null))' <<<"$GIT_TOOLS" >/dev/null
checkpoint "verify-git-runner-denies-bash"
GIT_BASH="$(mcp_call 8788 '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"bash","arguments":{"command":"id"}}}')"
jq -e '(.error != null) or (.result.isError == true)' <<<"$GIT_BASH" >/dev/null
checkpoint "private-clone-using-dedicated-executor-token"
PRIVATE_CLONE="$(mcp_call 8788 "$(jq -cn '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"git_execute",arguments:{operation:"clone",account:"personal",repository:"https://github.com/o258p0515/kiem-thu.git",destination:"private-empty"}}}')")"
if ! jq -e '.result.isError != true and .error == null' <<<"$PRIVATE_CLONE" >/dev/null; then
  echo "Private clone failed; sanitized MCP error follows:" >&2
  jq -r '.result.content[]?.text // .error.message // "no error text"' <<<"$PRIVATE_CLONE" >&2
  exit 1
fi
! grep -Eqi 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+' <<<"$PRIVATE_CLONE"
test ! -e "$ROOT/private-empty/.git"
checkpoint "public-clone-and-agent-shared-workspace"
PUBLIC_CLONE="$(mcp_call 8788 "$(jq -cn '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"git_execute",arguments:{operation:"clone",account:"personal",repository:"https://github.com/o258p0515/localmcpcoder-go.git",destination:"public-shared"}}}')")"
if ! jq -e '.result.isError != true and .error == null' <<<"$PUBLIC_CLONE" >/dev/null; then
  echo "Public/shared clone failed; sanitized MCP error follows:" >&2
  jq -r '.result.content[]?.text // .error.message // "no error text"' <<<"$PUBLIC_CLONE" >&2
  exit 1
fi
checkpoint "agent-write-shared-workspace"
AGENT_WRITE="$(mcp_call 8787 "$(jq -cn --arg command "cd $ROOT/public-shared && printf 'shared-workspace-check\\\\n' > issue23-shared-workspace.txt && pwd && ls -la" '{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"bash",arguments:{command:$command}}}')")"
echo "Agent write diagnostics:" >&2
jq -r '.result.content[]?.text // .error.message // "no error text"' <<<"$AGENT_WRITE" >&2
if ! jq -e '.result.isError != true and .error == null' <<<"$AGENT_WRITE" >/dev/null; then
  echo "Agent shared-workspace write failed; sanitized MCP error follows:" >&2
  jq -r '.result.content[]?.text // .error.message // "no error text"' <<<"$AGENT_WRITE" >&2
  exit 1
fi
checkpoint "verify-agent-cannot-see-private-git-metadata"
if [ -e "$ROOT/public-shared/.git" ]; then echo "private Git metadata marker leaked into Agent workspace" >&2; exit 1; fi
checkpoint "verify-git-runner-sees-agent-shared-workspace"
STATUS="$(mcp_call 8788 "$(jq -cn '{jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"git_execute",arguments:{operation:"status",account:"personal",path:"public-shared"}}}')")"
if ! jq -r '.result.content[]?.text // empty' <<<"$STATUS" | grep -q 'issue23-shared-workspace.txt'; then
  echo "Git status did not see Agent-created file; sanitized MCP response follows:" >&2
  jq -r '.result.content[]?.text // .error.message // "no error text"' <<<"$STATUS" >&2
  exit 1
fi
checkpoint "commit-and-push-dry-run-without-token-exposure"
PRIVATE_WRITE="$(mcp_call 8787 "$(jq -cn --arg command "cd $ROOT/private-empty && printf 'private-commit-check\\\\n' > README.md" '{jsonrpc:"2.0",id:8,method:"tools/call",params:{name:"bash",arguments:{command:$command}}}')")"
jq -e '.result.isError != true and .error == null' <<<"$PRIVATE_WRITE" >/dev/null
COMMIT="$(mcp_call 8788 "$(jq -cn '{jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"git_execute",arguments:{operation:"commit",account:"personal",path:"private-empty",message:"issue23 private metadata smoke"}}}')")"
jq -e '.result.isError != true and .error == null' <<<"$COMMIT" >/dev/null
PUSH="$(mcp_call 8788 "$(jq -cn '{jsonrpc:"2.0",id:10,method:"tools/call",params:{name:"git_execute",arguments:{operation:"push",account:"personal",path:"private-empty",ref:"main",dry_run:true}}}')")"
jq -e '.result.isError != true and .error == null' <<<"$PUSH" >/dev/null
! grep -Eqi 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+' <<<"$PUSH"
checkpoint "verify-fetch-pull-branch-log"
for op in fetch pull checkout log; do
  RESPONSE="$(mcp_call 8788 "$(jq -cn --arg op "$op" '{jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"git_execute",arguments:{operation:$op,account:"personal",path:"public-shared",ref:"main"}}}')")"
  jq -e '.result.isError != true and .error == null' <<<"$RESPONSE" >/dev/null
  ! grep -Eqi 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+' <<<"$RESPONSE"
done
checkpoint "verify-os-user-and-credential-isolation"
sudo -u mcp-git env ISSUE23_ISOLATION_SENTINEL=private-value sh -c \
  'install -d -m 700 /tmp/issue23-git-private; printf sentinel > /tmp/issue23-git-private/credential; chmod 600 /tmp/issue23-git-private/credential; exec sleep 90' &
SENTINEL_PID=$!
sleep 1
GIT_SERVER_PID="$(pgrep -u mcp-git -f "$BIN" | head -n1)"
if [ -z "$GIT_SERVER_PID" ]; then echo "cannot locate isolated Git executor process" >&2; exit 1; fi
ISOLATION_COMMAND="if cat /tmp/issue23-git-private/credential >/dev/null 2>&1; then exit 41; fi; if tr '\\\\000' '\\\\n' </proc/$GIT_SERVER_PID/environ 2>/dev/null | grep -q GIT_EXECUTOR_TOKEN; then exit 42; fi; if env | grep -q '^GIT_EXECUTOR_TOKEN='; then exit 43; fi; if ls /home/mcp-git/.localmcp-git/repos >/dev/null 2>&1; then exit 44; fi; if git -C public-shared rev-parse --git-dir >/dev/null 2>&1; then exit 45; fi; echo isolation-ok"
ISOLATION="$(mcp_call 8787 "$(jq -cn --arg command "$ISOLATION_COMMAND" '{jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"bash",arguments:{command:$command}}}')")"
jq -e '.result.isError != true and .error == null' <<<"$ISOLATION" >/dev/null
jq -r '.result.content[]?.text // empty' <<<"$ISOLATION" | grep -q 'isolation-ok'
sudo kill "$SENTINEL_PID" 2>/dev/null || true
checkpoint "verify-redacted-logs-and-temp-cleanup"
if grep -Eqi 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+' "$GIT_LOG" "$AGENT_LOG"; then
  echo "credential-like value found in runner logs" >&2
  exit 1
fi
if sudo find /tmp -maxdepth 1 -type d -name 'localmcp-git-auth-*' -print -quit | grep -q .; then
  echo "temporary Git credential directory was not cleaned" >&2
  exit 1
fi
echo "issue23 paired-runner smoke: PASS (dedicated-token/private clone, Git-only catalog, shared workspace, fetch/pull/push auth, UID isolation, temp cleanup)"

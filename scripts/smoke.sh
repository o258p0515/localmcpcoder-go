#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
port=18787
token=smoke-test-token-0123456789
cleanup(){ [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
(cd "$root/go" && CGO_ENABLED=0 go build -o "$tmp/mcp" ./cmd/mcp)
MCP_TOKEN="$token" "$tmp/mcp" --root "$tmp" --port "$port" --tunnel none >"$tmp/server.log" 2>&1 & pid=$!
for _ in $(seq 1 40); do if curl -fsS "http://127.0.0.1:$port/health" >/dev/null; then break; fi; sleep .25; done
rpc(){ curl -fsS -X POST "http://127.0.0.1:$port/mcp" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$1"; }
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -q 'skill_read'
rpc '{"jsonrpc":"2.0","id":2,"method":"resources/list"}' | grep -q 'getting-started'
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skill_read","arguments":{"name":"getting-started"}}}' | grep -q 'read_file'
rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_file","arguments":{"file_path":"../../etc/passwd"}}}' | grep -q 'outside'
echo 'smoke test passed'

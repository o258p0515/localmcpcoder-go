# LocalMCP Hub

This Cloudflare Worker provides one stable MCP endpoint and routes tool calls to multiple outbound-connected LocalMCP Go runners. Agents configure the Hub once; the agent can select a runner per MCP session or override the runner on an individual tool call.

## Agent endpoint

Configure one MCP server URL: `https://hub.<your-cloudflare-zone>/mcp`, with the existing `MCP_TOKEN` as a Bearer token (or `X-API-Key`).

Meta-tools:

- `list_runners`: list online and draining runners.
- `select_runner(runner_id)`: pin the current MCP session to a runner.
- `get_job_result(runner_id, job_id)`: retrieve an asynchronous result.

Every remote runner tool schema includes optional `runner_id` and `async` arguments. An explicit runner ID overrides the session selection.

## Deploy

The `Deploy LocalMCP Hub` workflow runs on pushes to `feat/localmcp-hub` and can also be dispatched manually once available on the default branch. It resolves the Cloudflare zone from the existing `CF_DOMAIN`, creates only the new proxied `hub.<zone>` DNS name when absent, derives a separate `ADMIN_TOKEN` from `MCP_TOKEN`, deploys the Worker, and smoke-tests the endpoint. It never changes `CF_DOMAIN` or writes new GitHub Secrets. If a conflicting DNS record or an unrelated Worker route exists, deployment stops rather than taking it over.

Runtime secrets:

- `MCP_TOKEN`: existing bearer token.
- `ADMIN_TOKEN`: separate HMAC-SHA256 derived from `MCP_TOKEN` and the Hub hostname.

`MCP_TOKEN` is used for Agent authentication, Go Runner WebSocket authentication, OAuth consent approval, and OAuth token signing. No separate `HUB_SHARED_SECRET` is required. `ADMIN_TOKEN` is derived at deploy time and is not persisted as a GitHub Secret.

## Start GitHub Actions runners

After the `hub-runner.yml` workflow is available on the default branch:

1. Dispatch `LocalMCP Hub Runner` once per machine.
2. Give each dispatch a unique `runner_name` (for example `build-01`, `test-his`) and optional `runner_tags`.
3. Keep the returned workflow run IDs; each runner ID is `<runner_name>-<workflow_run_id>`.
4. Use `duration_seconds` to control lifetime. The default is 20,400 seconds (5h40m), leaving a margin before the GitHub Actions job limit.

Multiple dispatches run independently; the workflow does not use the protected `example-run.yml`.

## Start a local runner

The local runner connects outbound to the Hub. It does not need a public inbound port or `cloudflared`.

### Linux / macOS

From the repository root:

```sh
cd go
go build -trimpath -o mcp ./cmd/mcp

# Set the existing MCP token locally; do not commit it or print it in logs.
export MCP_TOKEN='<existing MCP_TOKEN>'
export HUB_DOMAIN='hub.<your-cloudflare-zone>'
export HUB_URLS="https://$HUB_DOMAIN"
export RUNNER_ID="workstation-$(hostname)"
export RUNNER_TAGS="linux,go,workstation"

mkdir -p ./workspace
./mcp --root ./workspace --tunnel hub --hub-urls "$HUB_URLS" \
  --runner-tags "$RUNNER_TAGS"
```

### Windows PowerShell

From the repository root:

```powershell
Set-Location .\go
go build -trimpath -o mcp.exe ./cmd/mcp

$env:MCP_TOKEN = '<existing MCP_TOKEN>'
$env:HUB_DOMAIN = 'hub.<your-cloudflare-zone>'
$env:HUB_URLS = "https://$($env:HUB_DOMAIN)"
$env:RUNNER_ID = "workstation-$env:COMPUTERNAME"
$env:RUNNER_TAGS = "windows,go,workstation"

New-Item -ItemType Directory -Force .\workspace | Out-Null
.\mcp.exe --root .\workspace --tunnel hub --hub-urls $env:HUB_URLS \
  --runner-tags $env:RUNNER_TAGS
```

The runner sends keepalives every 45 seconds, reconnects with bounded exponential backoff, and drains active calls on SIGINT/SIGTERM. Before executing a child shell, it removes MCP, Cloudflare, Hub and admin credentials from that child process environment.

## Multi-runner end-to-end test

The `LocalMCP Hub Multi-Runner E2E` workflow validates two separate GitHub-hosted machines. Start two temporary `LocalMCP Hub Runner` workflows, then dispatch the E2E workflow with:

- `runner_a_id` / `runner_b_id`: `<runner_name>-<workflow_run_id>`.
- `runner_a_run_id` / `runner_b_run_id`: the two GitHub Actions workflow run IDs.
- `cancel_runners=true` only when those runner workflows are temporary and should be stopped after the test. The default is to leave runners online.

The deploy workflow also has an optional `run_e2e` input that starts two local Go runner processes on one GitHub-hosted machine and checks session pinning, cross-routing, six concurrent calls, the 45-second async transition, and graceful self-removal.

## Health and administration

- Health: `https://hub.<your-cloudflare-zone>/health`.
- Runner registry: `https://hub.<your-cloudflare-zone>/admin/runners` with `Authorization: Bearer <ADMIN_TOKEN>`.

The admin endpoint returns the current runner registry. The Worker uses SQLite Durable Objects and WebSocket Hibernation so idle WebSocket connections do not require an always-awake Worker.

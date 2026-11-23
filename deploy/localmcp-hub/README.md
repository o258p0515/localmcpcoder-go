# LocalMCP Hub

This Worker provides one stable MCP endpoint and routes tool calls to multiple outbound-connected LocalMCP Go runners.

## Agent endpoint

Configure one MCP server URL: `https://hub.<your-cloudflare-zone>/mcp`, with the existing `MCP_TOKEN` as a Bearer token (or `X-API-Key`).

Meta-tools:
- `list_runners`: list online and draining runners.
- `select_runner(runner_id)`: pin the current MCP session.
- `get_job_result(runner_id, job_id)`: retrieve an asynchronous result.

Every runner tool schema includes optional `runner_id` and `async` arguments. An explicit runner ID overrides the session selection.

## Deploy

The `Deploy LocalMCP Hub` workflow runs on pushes to `feat/localmcp-hub` and can also be dispatched manually once available on the default branch. It resolves the Cloudflare zone from the existing `CF_DOMAIN`, creates only the new proxied `hub.<zone>` DNS name when absent, derives internal/admin secrets from `MCP_TOKEN`, deploys the Worker, and smoke-tests the endpoint. It never changes `CF_DOMAIN` or writes new GitHub Secrets. If a conflicting DNS record already exists, deployment stops rather than taking over that hostname.

## Start a GitHub Actions runner

Run `LocalMCP Hub Runner` manually after the workflow is available on the default branch. Each dispatch starts an independent runner; set a unique name and optional tags. Multiple dispatches can run concurrently.

## Start a local runner

Derive the internal secret from the existing MCP token and the resolved zone hostname:

```sh
export HUB_DOMAIN='hub.<your-cloudflare-zone>'
export HUB_SHARED_SECRET="$(printf '%s' "localmcp-hub-internal-v1:$HUB_DOMAIN" | openssl dgst -sha256 -hmac "$MCP_TOKEN" -hex | awk '{print $2}')"
```

Then build from `go/` and start with:

```sh
MCP_TOKEN='<existing MCP_TOKEN>' HUB_URLS="wss://$HUB_DOMAIN" \
RUNNER_ID='workstation-01' RUNNER_TAGS='linux,go,dev' \
./mcp --tunnel hub --hub-urls "$HUB_URLS" --hub-secret "$HUB_SHARED_SECRET" \
  --runner-id "$RUNNER_ID" --runner-tags "$RUNNER_TAGS" --root ./workspace
```

The Hub client uses outbound WebSockets, reconnects with bounded exponential backoff, sends text keepalives every 45 seconds, and drains active calls on SIGINT/SIGTERM. It does not start cloudflared. The child shell environment removes MCP, Cloudflare, Hub and admin credentials before executing user commands.

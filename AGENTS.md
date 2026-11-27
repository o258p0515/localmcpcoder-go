# Agent Engineering Rules (`localmcpcoder-go`)

## 1. Single Source of Truth (`main` Only)
- **`main` is the only source of truth for production.** Always branch from the latest `origin/main` for every fix or feature.
- Do **not** reuse stale feature branches (such as `feat/localmcp-hub`) or deploy Cloudflare Workers from any branch other than `main`.
- Every change must go through a Pull Request against `main` with **LocalMCP Hub CI** (`hub-ci.yml`) and **Go CI** (`ci.yml`) passing before merge.
- Production deployment (`deploy-localmcp-hub.yml`) is hard-guarded to `refs/heads/main`. Merging into `main` triggers automatic deployment and smoke verification.

## 2. Production Preservation Guardrails
- Do **not** modify or overwrite `deploy/github-mcp-proxy/`, `.github/workflows/deploy-github-mcp-proxy.yml`, or `.github/workflows/example-run.yml`.
- Do **not** modify `CF_DOMAIN` or require new GitHub Actions Secrets unless explicitly requested by the repository owner.

## 3. Non-Negotiable Hub Contracts (Never Regress)
- **Full Tool Catalog Independence:** `tools/list` on `localmcp-hub` must always return at least the 16 baseline tools (3 Hub meta-tools + 13 Go runner tools) with `runner_id` and `async` injected, even when `0` or `>= 2` runners are online.
- **OAuth Compatibility:** `localmcp-hub` must preserve both:
  - Static OAuth client (`MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET`) accepting `MCP_OAUTH_REDIRECT_URIS` and per-app `https://oauth-redirect.googleusercontent.com/r/*` callbacks.
  - Dynamic Client Registration (`POST /register` persisted in `RegistryDO`) with PKCE `S256` and `token_endpoint_auth_method: "none"`.
- **SSE Framing:** Streamable HTTP SSE frames must use real newline characters (`\n` / `\n\n`), never escaped literal `\\n`.
- **Zero-Config Internal Handover & Alarm Guards:**
  - `deploy/localmcp-hub/scripts/prepare-deploy.mjs` must automatically bind `MCP_PROXY -> github-mcp-proxy` when present in the Cloudflare account; `RegistryDO` must route internal handovers over `env.MCP_PROXY.fetch` using the shared `MCP_TOKEN` without requiring extra secrets or webhook URLs.
  - `RegistryDO.alarm()` must skip runners with `handover_after < 0`, short leases (`<= 300s`), persistent providers (`instabox`, `upstashbox`), or no recent `tools/call` activity (`RunnerDO /activity` -> `handover_state = "skipped_idle"`).

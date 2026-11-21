# Multi-Account GitHub MCP Proxy

A Cloudflare Worker that proxies the official GitHub Remote MCP endpoint and selects a GitHub PAT from Firebase Realtime Database for each tool call. It supports Streamable HTTP (/mcp), legacy SSE (/sse and /messages), static token authentication, OAuth 2.1 authorization-code + PKCE, dynamic client registration, and encrypted RTDB caching.

## Architecture

- src/mcp: JSON-RPC proxy, dynamic upstream tool discovery, mandatory account schema injection, and transports.
- src/rtdb: Firebase Service Account RS256 exchange and encrypted account cache.
- src/auth: static token and OAuth 2.1.
- scripts: environment validation, Cloudflare KV preparation, and strict runtime-secret allowlist.
- The project is isolated in this directory; the existing Go MCP application is not modified.

## Firebase RTDB setup

Create a JSON object at /github_accounts. Example (replace placeholders with real PATs; never commit them):

    {
      "personal": {
        "username": "github-user",
        "token": "github_pat_REPLACE_ME",
        "description": "Personal account",
        "orgs": ["github-user"],
        "enabled": true,
        "readonly": false,
        "is_catalog_source": true
      },
      "work": {
        "username": "work-user",
        "token": "github_pat_REPLACE_ME",
        "description": "Work account",
        "orgs": ["example-org"],
        "enabled": true,
        "readonly": true
      }
    }

Recommended RTDB Security Rules: { "rules": { ".read": false, ".write": false } }

Encode the Firebase Service Account JSON file as one-line Base64:
- Linux: base64 -w 0 service-account.json
- macOS: base64 -i service-account.json | tr -d '\\n'
- Windows PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))

## GitHub Repository Secrets

The deployment workflow uses these preconfigured secrets: CF_API_EMAIL, CF_API_KEY, CF_DOMAIN, MCP_TOKEN, MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET, MCP_OAUTH_REDIRECT_URIS, TS_TRUST_CREDS, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_JSON_B64, RTDB_URL, and RTDB_AUTH_URL.

Runtime Firebase auth priority: FIREBASE_SERVICE_ACCOUNT_JSON_B64 → FIREBASE_SERVICE_ACCOUNT_JSON → fallback RTDB_AUTH_URL. When using Service Account, set RTDB_URL to the clean URL ending in /github_accounts.json. Otherwise RTDB_AUTH_URL must include ?auth=....

MCP_OAUTH_REDIRECT_URIS and TS_TRUST_CREDS are deliberately ignored and never sent to the Worker. OAuth accepts any syntactically valid redirect URI except javascript:, data:, vbscript: schemes and URIs with fragments. No redirect allowlist is required.

## Connect AI clients

- ChatGPT Connectors / Claude Web & Desktop (OAuth 2.1): https://<CF_DOMAIN>/mcp. Dynamic Client Registration is available; static clients may use MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET. Approve by entering MCP_TOKEN on /authorize.
- Gemini CLI / Cursor / Windsurf / Grok / custom agents: Streamable HTTP URL https://<CF_DOMAIN>/mcp, with Authorization: Bearer <MCP_TOKEN> or X-API-Key: <MCP_TOKEN>. Optional X-GitHub-Account: <alias> pins an account.
- Legacy clients: https://<CF_DOMAIN>/sse with the same static token or OAuth access token.

Before using GitHub tools, call list_github_accounts and pass the exact alias as the required account argument. Invalid aliases never fall back to another account.
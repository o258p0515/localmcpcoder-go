# localmcpcoder

A remote MCP server that exposes Claude-Code-style filesystem and shell tools from a local machine. This repository contains the original Node.js implementation as a reference and a standalone **Go implementation in go/**.

## Go version

The Go server targets Go 1.23+, CGO_ENABLED=0, and cross-compiles to Linux, macOS, and Windows on amd64 and arm64. It uses the standard library only and does not embed cloudflared or Tailscale binaries. Built-in skills are embedded in the executable.

The HTTP/JSON-RPC adapter uses the Go standard library rather than an external MCP SDK. This keeps the transport stateless (no MCP session store) and allows OAuth/bearer middleware on every POST request. It supports JSON responses and SSE message responses.

### Build and run

~~~bash
cd go
CGO_ENABLED=0 go build -trimpath -o ../mcp ./cmd/mcp
cd ..

# Local only (no tunnel)
MCP_TOKEN='at-least-16-characters-long' ./mcp --root "$PWD" --tunnel none

# Cloudflare named tunnel (API-managed DNS + tunnel)
CF_API_TOKEN='...' MCP_TOKEN='at-least-16-characters-long' \
  ./mcp --root "$PWD" --tunnel cloudflare --host mcp.example.com

# Existing Cloudflare tunnel token (API setup is skipped)
TUNNEL_TOKEN='...' MCP_TOKEN='at-least-16-characters-long' \
  ./mcp --root "$PWD" --tunnel cloudflare --host mcp.example.com

# Existing Tailscale node / Funnel
TS_AUTHKEY='...' MCP_TOKEN='at-least-16-characters-long' \
  ./mcp --root "$PWD" --tunnel tailscale --ts-mode funnel
~~~

The default tunnel mode is auto: Cloudflare is selected when CF_API_TOKEN or TUNNEL_TOKEN is set, Tailscale when TS_AUTHKEY is set, otherwise the server listens locally. The none mode never exposes the service publicly. Cloudflare API mode requires --host; TUNNEL_TOKEN mode uses an existing tunnel and may omit --host. Without --host or TUNNEL_HOST, the public URL cannot be inferred and the external readiness check is skipped.

Outside CI, if MCP_TOKEN is missing, the program generates a 192-bit token and saves it to .env with mode 0600, preserving other .env entries. In GitHub Actions (GITHUB_ACTIONS=true) a missing token is a hard error. Set MCP_TOKEN explicitly in CI. The passphrase is shown only on an interactive terminal outside CI; it is never printed in CI logs. Configured secrets are masked in GitHub Actions logs before tunnel startup.

### Configuration

| Flag | Environment | Default | Description |
|---|---|---:|---|
| --root | MCP_ROOT | . | Filesystem root exposed to file tools |
| --port | MCP_PORT | 8787 | Local HTTP port |
| --allow-outside-root | MCP_ALLOW_OUTSIDE_ROOT=1 | false | Allow file tools outside root (dangerous) |
| --shell | MCP_SHELL | bash / powershell | bash, powershell, or cmd |
| --max-output | MCP_MAX_OUTPUT | 60000 | Maximum characters returned by a tool |
| --tunnel | MCP_TUNNEL | auto | cloudflare, tailscale, none, or auto |
| --host | MCP_HOST | — | Public Cloudflare hostname |
| --skills-dir | MCP_SKILLS_DIR | — | Additional user skills directory |
| --ts-hostname | TS_HOSTNAME | mcp-<hostname> | Tailscale device hostname |
| --ts-mode | TS_MODE | funnel | funnel (public) or serve (tailnet only) |

### Authentication and OAuth

The HTTP MCP endpoint is POST /mcp. The passphrase can be used directly as Authorization: Bearer <MCP_TOKEN>, or clients can use OAuth 2.1 authorization-code flow with mandatory PKCE S256. Discovery and registration endpoints:

- /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp
- /.well-known/oauth-authorization-server, /.well-known/oauth-authorization-server/mcp, and /.well-known/openid-configuration
- POST /oauth/register (dynamic client registration; client IDs are signed metadata blobs)
- GET/POST /oauth/authorize (consent page)
- POST /oauth/token (authorization code and refresh grants)

OAuth client IDs, authorization codes, access tokens, and refresh tokens are HMAC-SHA256-signed stateless tokens. The signing key is derived from MCP_TOKEN with HKDF. Access tokens are audience-bound and expire after one hour; refresh tokens expire after 30 days. Authorization codes expire after 60 seconds. A small in-memory set enforces best-effort single-use authorization codes on each process; another overlapping instance cannot see that set. Refresh tokens are not rotated or revoked, and there is no distributed revocation store. Restarting an instance therefore does not invalidate correctly signed tokens, but replay protection is intentionally best-effort.

The passphrase consent page locks out after five failed attempts for 60 seconds. Public origin URLs are derived from X-Forwarded-Proto and X-Forwarded-Host, so deploy behind a trusted proxy only. /health is public and returns only {"status":"ok"}. GET and DELETE /mcp return 405; the deprecated /mcp/<token> route returns 410.

### Cloudflare setup

For API-managed named tunnels, create an API token with these scopes:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**
- **Zone → Zone → Read**

The Go provider locates the most specific matching zone, reuses or creates a tunnel named mcp-<hostname-with-dashes>, writes ingress configuration, and upserts a proxied CNAME to <tunnel-id>.cfargotunnel.com. It runs cloudflared tunnel --no-autoupdate run with TUNNEL_TOKEN in the child environment (never in argv), restarts the process with exponential backoff, and waits for https://<host>/health. The binary resolver checks CLOUDFLARED_BIN, PATH, the user cache, then downloads over HTTPS. macOS .tgz assets are extracted; cloudflared is not embedded in the MCP executable.

For an existing named tunnel, set TUNNEL_TOKEN (and preferably --host or TUNNEL_HOST so the server can print and verify the public URL); the Cloudflare API is skipped. Without a hostname, the server starts the tunnel but cannot infer the public URL or perform the external readiness check. Keep the token in your secret manager. Never commit it.

### Tailscale setup

For public MCP clients use the default --ts-mode funnel; Funnel and HTTPS certificates must be enabled in the tailnet policy. Use --ts-mode serve for tailnet-only access. If tailscale status already works, the provider reuses that daemon and does not start another. Otherwise on Linux it resolves tailscale and tailscaled static binaries at runtime from the Tailscale stable package archive, starts an ephemeral userspace daemon (--tun=userspace-networking --state=mem:), and authenticates it with TS_AUTHKEY. The downloaded binaries are cached under the user cache directory (the stable static archive version is pinned in go/internal/tunnel/provider.go) and are not embedded in the MCP executable. On macOS/Windows, an existing Tailscale installation/service must be running. The provider checks funnel --help / serve --help for --bg, reads Self.DNSName from tailscale status --json, and resets Funnel/Serve on shutdown; it logs out only the ephemeral daemon it started.

### Built-in skills

Skills are Markdown files with YAML frontmatter (name, description) embedded from go/skills/*/SKILL.md. User skills in --skills-dir and <root>/.mcp/skills override built-ins by name. Only names and descriptions are advertised initially. MCP clients can retrieve bodies through:

- server instructions (which asks clients to read a matching skill before non-trivial work)
- resources/list and resources/read using skill://<name> URIs
- prompts/list and prompts/get
- fallback tools skills_list, skill_read, and skills_reload

### Tools

| Tool | Purpose |
|---|---|
| bash | Run bash, PowerShell, or cmd with timeout, bounded stdout/stderr, and exit code; secret env vars are scrubbed |
| read_file | Read text with line numbers, offset, and limit (maximum 5,000 lines per call) |
| write_file | Create/overwrite files and parent directories |
| edit_file | Exact replacement; requires a unique match unless replace_all=true |
| list_dir | List directory entries |
| glob | Recursive filename matching with **, ignored directories, mtime sort, 500-result cap |
| grep | Go RE2 regex search; skips binary files and files over 2 MB; 200-result default cap |
| todo_write / todo_read | Replace/read the current server-session task list (in-memory; not persisted across restarts) |
| system_info | Report OS, architecture, hostname, root, and shell |
| skills_list / skill_read / skills_reload | Discover, read, and reload skills |

grep uses Go's RE2 engine: lookahead, lookbehind, and backreferences are not supported. Search skips node_modules, .git, .venv, venv, __pycache__, dist, build, .next, .cache, .idea, .gradle, and target.

### Extending tools

Each handler lives in its own file under go/internal/tools/. Add its typed input struct with json and optional description/required tags, register it through the generic Add[In] helper from registry.go, and keep dependencies in Deps (config, filesystem resolver, skills store, logger). The helper derives the input JSON schema and converts handler errors into MCP isError results; the registry clamps returned text to MCP_MAX_OUTPUT.

### GitHub Actions

The release workflow builds six static executables for tags and attaches SHA256 checksums. The optional example runner can keep a Cloudflare-backed MCP server online for a bounded job window. Configure repository secrets CF_API_TOKEN, MCP_TOKEN, and MCP_HOST, then trigger Example remote MCP runner manually. It uses the published Linux amd64 release asset and is scheduled every five hours with a 355-minute job timeout to stay below GitHub-hosted runner limits.

**Important:** GitHub-hosted Actions runners are ephemeral and have a maximum job duration of 6 hours. Long-running interactive workloads may conflict with GitHub Actions terms of service or acceptable-use policies. Review current GitHub terms before using Actions as a persistent remote computer. Files on the runner disappear when the job ends; commit/push or upload artifacts to preserve outputs. Never log secrets.

### Build, test, and release

~~~bash
make test
make vet
./scripts/smoke.sh
make dist VERSION=1.2.3
~~~

The dist target cross-compiles Linux/macOS/Windows × amd64/arm64 with CGO_ENABLED=0, -trimpath, and stripped symbols. The executable does not contain cloudflared or Tailscale.

### Security

This is remote code execution as the operating-system user running the server. Anyone holding the passphrase or a valid OAuth access token can run shell commands and read/write files as that user. The filesystem root constrains file tools; it is not a sandbox for shell commands. A shell command can cd elsewhere or access the network. Symlink resolution is performed before path-boundary checks. Keep the server private, use a high-entropy passphrase, restrict client permissions, and stop the process when not in use. Never expose it publicly unless you understand and accept the consequences.

The bash tool removes CF_API_TOKEN, CF_API_KEY, TS_AUTHKEY, TS_TRUST_CREDS, MCP_TOKEN, and TUNNEL_TOKEN from its child environment. Tunnel subprocesses also scrub those secrets from their environment; TUNNEL_TOKEN is re-added only to the cloudflared child environment and is never placed in argv.

## Original Node.js implementation

The original server.js, oauth.js, start*.sh|ps1, package.json, and lockfile are retained unchanged as a behavioral reference and legacy runtime. They still require Node.js and cloudflared to be installed. See [README-node.md](README-node.md) for the original Node runtime documentation. The Go version is independent and lives under go/.

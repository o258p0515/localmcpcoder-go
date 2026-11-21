# localmcpcoder

A remote MCP server that gives ChatGPT, Claude (web) — or any MCP client — Claude Code style tools
on **your own machine**: run shell commands, read, write and edit files, search the
filesystem, and keep a task list.

It runs locally and is published to the internet through a free Cloudflare tunnel, so a
web chat can actually work on your computer instead of just talking about it — no coding
CLI to install or subscribe to.

> **Read the [Security](#security) section before exposing this.** This is remote code
> execution on your machine, by design.

---

## Requirements

| | | |
|---|---|---|
| macOS, Linux or Windows 10/11 | | Shell defaults to `bash`, or `powershell` on Windows |
| [Node.js](https://nodejs.org) 22+ | `node -v` | 22 or newer (uses the built-in `fs.glob`) |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | `cloudflared --version` | Installed in step 2 below |
| A web chat that takes connectors | | ChatGPT or Claude — anything that speaks Streamable HTTP |

---

## Installation

**1. Get the code and install the dependencies**

```bash
git clone https://github.com/JuanseGZZ/localmcpcoder.git
cd localmcpcoder
npm install
```

**2. Install cloudflared**

```bash
brew install cloudflared                          # macOS
winget install --id Cloudflare.cloudflared -e     # Windows
```

On Windows, **close and reopen PowerShell** afterwards so `cloudflared` lands on your
`PATH`. Check it on either platform:

```bash
cloudflared --version
```

That is the whole installation. The access token is generated automatically on first
run and saved to `.env`, which is gitignored — you never create it by hand.

---

## Running it

```bash
cd localmcpcoder
./start.sh          # macOS / Linux
.\start.ps1         # Windows
```

This starts the server on `127.0.0.1:8787`, opens the tunnel, and prints a public URL
that it also copies to your clipboard:

```
=============================================================
 READY. Paste this URL into your MCP client:

   https://random-words-here.trycloudflare.com/mcp

 Authentication: OAuth. Leave client ID and secret blank —
 the client registers itself.

 Then the browser will ask for this passphrase:

   0a14bdd6c9f2...

 Exposed folder: /Users/me/localmcpcoder
=============================================================
```

**Leave that window open.** Closing it, or pressing `Ctrl+C`, shuts down both the server
and the tunnel.

Common options:

```bash
./start.sh --root ~/projects          # expose a different folder
./start.sh --port 8788                # use a different port
./start.sh --allow-outside-root       # whole disk — see Security
```

```powershell
.\start.ps1 -Root "C:\Users\me\projects"
.\start.ps1 -Port 8788
.\start.ps1 -AllowOutsideRoot
```

### Connecting it to ChatGPT

Two steps, in two different settings pages.

**1. Turn on Developer mode** — **Settings** → **Security and login** → scroll to
**Developer mode** → toggle it on. It is flagged as elevated risk because it is exactly
what lets an unverified connector like this one write to your machine; with it off, only
the search-style tools get wired up.

**2. Add the connector** — **Settings** → **Plugins** → the **`+`** button →

- **URL**: the URL printed above, ending in `/mcp`.
- **Authentication**: **OAuth**. Leave client ID and secret **blank** — the server
  supports dynamic client registration, so ChatGPT registers itself.

Save, then click **Connect**. A page opens asking for the **passphrase** printed by
`start.sh` (it is also in `.env`). Approve, and it should show as **Connected** with the
ten tools below. Open a chat, enable it from the tools menu, and try *"list the files in
the folder"*.

### Connecting it to Claude

**Settings** → **Connectors** → **Add** → **Add custom connector** → paste the same URL
ending in `/mcp`. Leave the OAuth client ID and secret blank under advanced settings.
Click **Connect** and approve with the passphrase.

The server is a plain Streamable HTTP endpoint, so any MCP client that can point at a
URL will work.

### Authentication

The connector URL used to end in `/mcp/<token>`, which meant the secret was written into
every proxy, edge and browser log the request passed through. It doesn't anymore.

The server is now its own OAuth 2.1 authorization server, implementing the parts of the
MCP authorization spec that ChatGPT and Claude drive automatically:

| | |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 — points clients at the authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — endpoint discovery |
| `POST /oauth/register` | RFC 7591 — the client registers itself, so there is no client ID or secret to copy |
| `GET`/`POST /oauth/authorize` | Consent page; PKCE with S256 is mandatory |
| `POST /oauth/token` | Audience-bound access tokens (RFC 8707), rotating refresh tokens |

The **passphrase** (the value in `.env`) is what you type on the consent page. It never
travels in a URL. Everything else is a short-lived token in an `Authorization` header.

For CLI clients, the passphrase also works directly as a bearer token — still a header,
so still not log-visible:

```bash
curl -X POST https://<host>/mcp \
  -H "Authorization: Bearer $(grep MCP_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Tokens live in memory, so **restarting the server signs every client out** and they
re-authorize on next use.

### Restarting later

The free tunnel gives you a **new URL every time you start it**. The passphrase stays the
same — it lives in `.env` — but the hostname changes, so re-paste the URL into the
connector and re-approve after each restart.

---

## Tools

| Tool | What it does |
|---|---|
| `bash` | Runs a shell command — bash, or PowerShell on Windows (working dir, timeout, exit code) |
| `read_file` | Reads a file with line numbers (`offset` / `limit`) |
| `write_file` | Creates or overwrites a file |
| `edit_file` | Exact string replacement, with `replace_all` |
| `list_dir` | Lists a directory |
| `glob` | Finds files by pattern (`**/*.js`) |
| `grep` | Searches a regex across file contents |
| `todo_write` / `todo_read` | Session task list |
| `system_info` | OS, user, allowed root, shell |

---

## Configuration

`start.sh` / `start.ps1` set these for you; set them by hand only if you run
`node server.js` directly.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TOKEN` | — | The passphrase, required, 16 characters minimum |
| `MCP_PORT` | `8787` | Local port |
| `MCP_ROOT` | cwd | The only folder that can be accessed |
| `MCP_ALLOW_OUTSIDE_ROOT` | `0` | `1` allows the whole disk |
| `MCP_SHELL` | `bash`, or `powershell` on Windows | `bash`, `powershell` or `cmd` |
| `MCP_MAX_OUTPUT` | `60000` | Max characters per tool response |

### Using your own domain instead

If you own a domain on Cloudflare, you can swap the random URL for a fixed one. Create a
named tunnel in the Cloudflare Zero Trust dashboard, install it as a service, and point a
public hostname at `http://localhost:8787`. Then run [`start-server.sh`](start-server.sh)
(or [`start-server.ps1`](start-server.ps1)) instead — they start only the server and leave
the tunnel to the service. A named tunnel requires a domain in your Cloudflare account;
without one, use the quick tunnel above.

---

## Security

This publishes **remote code execution on your machine** to the internet. Anyone holding
the passphrase can do anything you can do on that computer.

- **The passphrase is the password**, and it is 192 bits of randomness — not guessable.
  It lives in `.env`, which is gitignored. Keep it that way. To rotate it, delete `.env`
  and restart. Do not paste it into a repo, an issue, a screenshot, or a chat you do not
  control.
- **Nothing is reachable without it.** Every endpoint except the OAuth discovery
  documents requires a bearer token, `/health` included.
- **`bash` has no allowlist, and `MCP_ROOT` does not contain it.** The root restriction
  applies to the file tools and to the working directory a command starts in — not to
  what the command does once it runs. `cd ~` works. So does `curl`. Treat `MCP_ROOT` as
  a limit on the file tools, not as a sandbox around the shell.
- **The file tools resolve symlinks** before the root check, so a link inside the root
  that points outside it is rejected rather than followed.
- **Prompt injection is the realistic attack.** You are not defending against someone
  guessing the passphrase; you are defending against a web page, a README or an email
  the model reads talking it into running something. Keep the connector on *ask before
  each action* rather than *allow all*.
- **Shut it down when you are not using it** (`Ctrl+C`).

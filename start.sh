#!/usr/bin/env bash
# =============================================================================
#  localmcpcoder — starts the MCP server AND a free Cloudflare quick tunnel.
#  macOS / Linux counterpart of start.ps1.
#
#  Usage:  ./start.sh
#          ./start.sh --root ~/projects
#          ./start.sh --port 8788
#          ./start.sh --allow-outside-root      # whole disk — dangerous
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/.env"

root="$here"
port=8787
allow_outside=0

while [ $# -gt 0 ]; do
  case "$1" in
    --root)                root="$2"; shift 2 ;;
    --port)                port="$2"; shift 2 ;;
    --allow-outside-root)  allow_outside=1; shift ;;
    -h|--help)             sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
cyn()  { printf '\033[36m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

# --- 1. Persistent access token ---------------------------------------------
token=""
if [ -f "$env_file" ]; then
  token="$(grep -m1 '^MCP_TOKEN=' "$env_file" | cut -d= -f2- || true)"
fi
if [ "${#token}" -lt 16 ]; then
  token="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  printf 'MCP_TOKEN=%s\n' "$token" > "$env_file"
  chmod 600 "$env_file"
  ylw "New token generated and saved to .env"
fi

# --- 2. Locate cloudflared ---------------------------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
  red "cloudflared not found. Install it with:"
  red "  brew install cloudflared"
  red "then open a new terminal and try again."
  exit 1
fi

# --- 3. MCP server -----------------------------------------------------------
# Make sure the port is free: if something else is already listening, the health
# check below would report a false "OK" against that other process.
if busy_pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" && [ -n "$busy_pids" ]; then
  echo
  red "Port $port is already in use (PID: $(echo "$busy_pids" | tr '\n' ' '))."
  red "There is probably another copy of localmcpcoder running. You can:"
  red "  - close the other terminal running it, or"
  red "  - kill $(echo "$busy_pids" | tr '\n' ' ')"
  red "  - or use another port:  ./start.sh --port 8788"
  exit 1
fi

export MCP_TOKEN="$token"
export MCP_ROOT="$(cd "$root" && pwd)"
export MCP_PORT="$port"
export MCP_ALLOW_OUTSIDE_ROOT="$allow_outside"

run_id="$$-$(date +%H%M%S)"
tmp="${TMPDIR:-/tmp}"
srv_log="$tmp/localmcpcoder-server-$run_id.log"
tun_log="$tmp/localmcpcoder-tunnel-$run_id.log"

server_pid=""
tunnel_pid=""
cleanup() {
  trap - EXIT INT TERM   # only ever run once
  ylw "Shutting down..."
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

echo
cyn "Starting MCP server..."
node "$here/server.js" > "$srv_log" 2>&1 &
server_pid=$!

# Wait until it is actually listening
listening=0
for _ in $(seq 1 30); do
  sleep 0.4
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    listening=1
    break
  fi
done
if [ "$listening" -ne 1 ]; then
  red "The server failed to start. Log:"
  cat "$srv_log" || true
  exit 1
fi
grn "  OK - listening on 127.0.0.1:$port"

# --- 4. Cloudflare quick tunnel ---------------------------------------------
cyn "Opening Cloudflare tunnel (free, no account needed)..."
cloudflared tunnel --url "http://localhost:$port" --no-autoupdate > "$tun_log" 2>&1 &
tunnel_pid=$!

public_url=""
for _ in $(seq 1 60); do
  sleep 0.5
  public_url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tun_log" 2>/dev/null | head -n1 || true)"
  [ -n "$public_url" ] && break
done

if [ -z "$public_url" ]; then
  red "Could not get the tunnel URL. Log: $tun_log"
  exit 1
fi

full_url="$public_url/mcp"

echo
grn "============================================================="
grn " READY. Paste this URL into your MCP client:"
echo
printf '   %s\n' "$full_url"
echo
grn " Authentication: OAuth. Leave client ID and secret blank —"
grn " the client registers itself."
echo
grn " Then the browser will ask for this passphrase:"
echo
printf '   %s\n' "$token"
echo
grn " Exposed folder: $MCP_ROOT"
grn "============================================================="
echo
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$full_url" | pbcopy
  printf '\033[90m%s\033[0m\n' "(URL copied to the clipboard. Press Ctrl+C to shut everything down.)"
else
  printf '\033[90m%s\033[0m\n' "(Press Ctrl+C to shut everything down.)"
fi
printf '\033[90m%s\033[0m\n' "(The passphrase is also in .env, and never travels in a URL.)"
echo

# --- 5. Stay alive, clean up on exit -----------------------------------------
while true; do
  sleep 2
  if ! kill -0 "$server_pid" 2>/dev/null; then red "The MCP server stopped."; break; fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then red "The tunnel stopped."; break; fi
done

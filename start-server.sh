#!/usr/bin/env bash
# =============================================================================
#  localmcpcoder — starts ONLY the MCP server, without a tunnel.
#  macOS / Linux counterpart of start-server.ps1.
#
#  Use this when your tunnel already runs on its own, e.g. a Cloudflare named
#  tunnel installed as a service. Otherwise use start.sh, which also opens a
#  free quick tunnel for you.
#
#  Usage:  ./start-server.sh
#          ./start-server.sh --root ~/projects
#          ./start-server.sh --allow-outside-root      # whole disk — dangerous
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
    -h|--help)             sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Persistent access token (same one start.sh uses) ------------------------
token=""
if [ -f "$env_file" ]; then
  token="$(grep -m1 '^MCP_TOKEN=' "$env_file" | cut -d= -f2- || true)"
fi
if [ "${#token}" -lt 16 ]; then
  token="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  printf 'MCP_TOKEN=%s\n' "$token" > "$env_file"
  chmod 600 "$env_file"
  printf '\033[33m%s\033[0m\n' "New token generated and saved to .env"
fi

if busy_pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" && [ -n "$busy_pids" ]; then
  printf '\033[31m%s\033[0m\n' \
    "Port $port is already in use (PID: $(echo "$busy_pids" | tr '\n' ' ')). Stop it or use --port 8788."
  exit 1
fi

export MCP_TOKEN="$token"
export MCP_ROOT="$(cd "$root" && pwd)"
export MCP_PORT="$port"
export MCP_ALLOW_OUTSIDE_ROOT="$allow_outside"

echo
printf '\033[36m%s\033[0m\n' "Connector URL: https://<your-hostname>/mcp   (Authentication: OAuth)"
printf '\033[36m%s\033[0m\n' "Passphrase the consent page will ask for:"
printf '   %s\n' "$token"
echo

exec node "$here/server.js"
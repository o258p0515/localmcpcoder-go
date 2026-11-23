import { handleMcp } from "./mcp-router";
import { handleOAuthRequest, verifyOAuthAccessToken } from "./oauth";
import { RegistryDO } from "./registry-do";
import { RunnerDO } from "./runner-do";
import type { Env } from "./types";
export { RegistryDO, RunnerDO };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, X-Session-Id, X-Runner-Id, X-API-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Vary": "Origin"
};
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function equalSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function bearer(request: Request): string {
  const value = request.headers.get("Authorization") ?? "";
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : request.headers.get("X-API-Key") ?? "";
}
function authorized(request: Request, secret: string): boolean { return equalSecret(bearer(request), secret); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (url.pathname === "/health") return withCors(Response.json({ status: "ok", service: "localmcp-hub", time: new Date().toISOString() }));
    if (url.pathname === "/internal/runner-ws") {
      if (!authorized(request, env.MCP_TOKEN)) return new Response("unauthorized", { status: 401 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket upgrade required", { status: 426 });
      const id = url.searchParams.get("id") ?? "";
      if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) return new Response("invalid runner id", { status: 400 });
      const stub = env.RUNNER_DO.get(env.RUNNER_DO.idFromName(id));
      return stub.fetch(new Request("https://runner/connect" + url.search, { method: "GET", headers: request.headers }));
    }
    if (url.pathname === "/admin/runners") {
      if (!authorized(request, env.ADMIN_TOKEN)) return new Response("unauthorized", { status: 401 });
      const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("global"));
      const response = await stub.fetch("https://registry/internal", { method: "POST", body: JSON.stringify({ action: "listRunners" }) });
      const data = await response.json() as any;
      if (!(request.headers.get("Accept") ?? "").includes("text/html")) return withCors(Response.json(data.result ?? []));
      const rows = (data.result ?? []).map((r: any) => `<tr><td>${escapeHtml(r.runner_id)}</td><td>${escapeHtml(r.os)}/${escapeHtml(r.arch)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml((r.tags ?? []).join(", "))}</td><td>${new Date(r.connected_at).toISOString()}</td></tr>`).join("");
      return withCors(new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LocalMCP Hub</title><style>body{font:15px system-ui;margin:2rem;background:#f6f7f9;color:#17202a}table{border-collapse:collapse;background:white;width:100%}td,th{padding:.7rem;border:1px solid #ddd;text-align:left}h1{font-size:1.5rem}</style></head><body><h1>LocalMCP Hub runners</h1><table><thead><tr><th>Runner</th><th>Platform</th><th>Status</th><th>Tags</th><th>Connected</th></tr></thead><tbody>${rows || "<tr><td colspan=5>No runners connected</td></tr>"}</tbody></table></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const issuer = url.origin;
      return withCors(Response.json({
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["mcp:tools"]
      }));
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return withCors(Response.json({
        resource: url.origin + "/mcp",
        authorization_servers: [url.origin],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp:tools"]
      }));
    }
    if (url.pathname === "/authorize" || url.pathname === "/token") {
      return withCors(await handleOAuthRequest(request, env));
    }
    if (url.pathname === "/mcp") {
      const staticAuth = authorized(request, env.MCP_TOKEN);
      const oauthAuth = await verifyOAuthAccessToken(bearer(request), env.MCP_TOKEN);
      if (!staticAuth && !oauthAuth) return withCors(new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="localmcp-hub", resource_metadata="' + url.origin + '/.well-known/oauth-protected-resource"' } }));
      if (!request.headers.get("Content-Type")?.includes("application/json")) return withCors(new Response("application/json required", { status: 415 }));
      const supplied = request.headers.get("Mcp-Session-Id") ?? request.headers.get("X-Session-Id");
      const session = supplied && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
      return withCors(await handleMcp(request, env, session));
    }
    return withCors(new Response("not found", { status: 404 }));
  }
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);
}

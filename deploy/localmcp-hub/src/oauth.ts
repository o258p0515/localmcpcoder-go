import type { Env } from "./types";

type Claims = { typ: "code" | "access" | "refresh"; sub: string; exp: number; redirect_uri?: string; challenge?: string; state?: string; jti: string };
const enc = (bytes: Uint8Array) => {
  let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
};
const dec = (value: string) => {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
const equal = (a: string, b: string) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};
function redirects(env: Env): string[] {
  const raw = env.MCP_OAUTH_REDIRECT_URIS?.trim() ?? "";
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string"); } catch { /* accept newline/comma separated secrets */ }
  return raw.split(/[\\r\\n,]+/).map((v) => v.trim()).filter(Boolean);
}
function allowedRedirect(env: Env, value: string): boolean {
  try {
    const u = new URL(value);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.hash) return false;
    if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "[::1]") return false;
    return redirects(env).includes(value);
  } catch { return false; }
}
async function key(env: Env): Promise<CryptoKey> {
  if (!env.HUB_SHARED_SECRET) throw new Error("Hub OAuth signing secret is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.HUB_SHARED_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(env: Env, claims: Claims): Promise<string> {
  const payload = enc(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(payload)));
  return payload + "." + enc(sig);
}
async function verify(env: Env, token: string): Promise<Claims | null> {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify("HMAC", await key(env), dec(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(dec(payload))) as Claims;
    if (!claims.typ || claims.exp <= Math.floor(Date.now() / 1000) || !claims.sub) return null;
    return claims;
  } catch { return null; }
}
async function pkce(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return enc(digest);
}
function randomId(): string { return enc(crypto.getRandomValues(new Uint8Array(24))); }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
async function form(request: Request): Promise<Record<string, string>> {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json() as Record<string, string>;
  const data = await request.formData(), result: Record<string, string> = {};
  for (const [k, v] of data.entries()) if (typeof v === "string") result[k] = v;
  return result;
}
function clientValid(env: Env, id: string, secret: string): boolean {
  return !!env.MCP_OAUTH_CLIENT_ID && equal(id, env.MCP_OAUTH_CLIENT_ID) &&
    !!env.MCP_OAUTH_CLIENT_SECRET && equal(secret, env.MCP_OAUTH_CLIENT_SECRET);
}
async function issueTokens(env: Env, clientId: string) {
  const now = Math.floor(Date.now() / 1000);
  const access_token = await sign(env, { typ: "access", sub: clientId, exp: now + 86400, jti: randomId() });
  const refresh_token = await sign(env, { typ: "refresh", sub: clientId, exp: now + 2592000, jti: randomId() });
  return { access_token, token_type: "Bearer", expires_in: 86400, refresh_token, scope: "mcp:tools" };
}
export async function verifyOAuthAccessToken(token: string, signingSecret: string): Promise<boolean> {
  if (!token || !signingSecret) return false;
  try {
    const signingKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    if (!await crypto.subtle.verify("HMAC", signingKey, dec(signature), new TextEncoder().encode(payload))) return false;
    const claims = JSON.parse(new TextDecoder().decode(dec(payload))) as Claims;
    return claims.typ === "access" && !!claims.sub && claims.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
export async function handleOAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize" && request.method === "GET") {
    const p = url.searchParams, clientId = p.get("client_id") ?? "", redirect = p.get("redirect_uri") ?? "";
    if (p.get("response_type") !== "code" || !env.MCP_OAUTH_CLIENT_ID || !equal(clientId, env.MCP_OAUTH_CLIENT_ID) ||
        !allowedRedirect(env, redirect) || !p.get("code_challenge") || p.get("code_challenge_method") !== "S256") {
      return new Response("Invalid OAuth request: client, redirect URI and PKCE S256 are required", { status: 400 });
    }
    const csrf = randomId();
    const html = '<!doctype html><meta charset="utf-8"><title>Authorize LocalMCP Hub</title><h1>Authorize LocalMCP Hub</h1><p>Client: ' +
      escapeHtml(clientId) + '</p><p>Redirect: <code>' + escapeHtml(redirect) + '</code></p>' +
      '<form method="post" action="/authorize"><input type="hidden" name="csrf" value="' + csrf + '">' +
      '<input type="hidden" name="client_id" value="' + escapeHtml(clientId) + '">' +
      '<input type="hidden" name="redirect_uri" value="' + escapeHtml(redirect) + '">' +
      '<input type="hidden" name="state" value="' + escapeHtml(p.get("state") ?? "") + '">' +
      '<input type="hidden" name="code_challenge" value="' + escapeHtml(p.get("code_challenge") ?? "") + '">' +
      '<label>Enter MCP_TOKEN <input type="password" name="approval_token" required></label><button>Approve</button></form>';
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Set-Cookie": "hub_oauth_csrf=" + csrf + "; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=600" } });
  }
  if (url.pathname === "/authorize" && request.method === "POST") {
    const b = await form(request), cookie = request.headers.get("Cookie") ?? "", match = /(?:^|;\\s*)hub_oauth_csrf=([^;]+)/.exec(cookie);
    if (!match || !equal(match[1] ?? "", b.csrf ?? "") || !env.MCP_TOKEN || !equal(b.approval_token ?? "", env.MCP_TOKEN)) {
      return new Response("Authorization denied", { status: 403 });
    }
    const clientId = b.client_id ?? "", redirect = b.redirect_uri ?? "";
    if (!env.MCP_OAUTH_CLIENT_ID || !equal(clientId, env.MCP_OAUTH_CLIENT_ID) || !allowedRedirect(env, redirect) ||
        !b.code_challenge || !b.state && b.state !== "") return new Response("Invalid OAuth authorization", { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const code = await sign(env, { typ: "code", sub: clientId, exp: now + 300, redirect_uri: redirect, challenge: b.code_challenge, state: b.state, jti: randomId() });
    const target = new URL(redirect); target.searchParams.set("code", code); if (b.state) target.searchParams.set("state", b.state);
    return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "Set-Cookie": "hub_oauth_csrf=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0" } });
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const b = await form(request);
    let clientId = b.client_id ?? "", clientSecret = b.client_secret ?? "";
    const basic = request.headers.get("Authorization")?.match(/^Basic\\s+(.+)$/i)?.[1];
    if (basic) {
      try { const decoded = atob(basic); const i = decoded.indexOf(":"); clientId = decoded.slice(0, i); clientSecret = decoded.slice(i + 1); }
      catch { return json({ error: "invalid_client" }, 401); }
    }
    if (!clientValid(env, clientId, clientSecret)) return json({ error: "invalid_client" }, 401);
    if (b.grant_type === "authorization_code") {
      const claims = await verify(env, b.code ?? "");
      if (!claims || claims.typ !== "code" || claims.sub !== clientId || claims.redirect_uri !== b.redirect_uri ||
          !allowedRedirect(env, b.redirect_uri ?? "") || !claims.challenge || await pkce(b.code_verifier ?? "") !== claims.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json(await issueTokens(env, clientId));
    }
    if (b.grant_type === "refresh_token") {
      const claims = await verify(env, b.refresh_token ?? "");
      if (!claims || claims.typ !== "refresh" || claims.sub !== clientId) return json({ error: "invalid_grant" }, 400);
      return json(await issueTokens(env, clientId));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  return new Response("Method Not Allowed", { status: 405 });
}

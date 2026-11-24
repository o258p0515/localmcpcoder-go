import type { Env } from "./types";

type Claims = { typ: "code" | "access" | "refresh"; sub: string; exp: number; scope?: string; redirect_uri?: string; challenge?: string; state?: string; jti: string };
type OAuthClient = {
  client_id: string;
  client_name: string;
  token_endpoint_auth_method: "none" | "client_secret_basic" | "client_secret_post";
  client_secret?: string;
  client_secret_hash?: string;
  redirect_uris: string[];
  is_static?: boolean;
};

const enc = (bytes: Uint8Array) => {
  let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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
async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function redirects(env: Env): string[] {
  const raw = env.MCP_OAUTH_REDIRECT_URIS?.trim() ?? "";
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string"); } catch { /* accept newline/comma separated secrets */ }
  return raw.split(/[\r\n,]+/).map((v) => v.trim()).filter(Boolean);
}
export function isValidRedirectUri(value: string): boolean {
  try {
    const u = new URL(value);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.hash) return false;
    if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "[::1]") return false;
    return true;
  } catch { return false; }
}
function matchesAllowedRedirect(allowed: string, candidate: string, candidateUrl: URL): boolean {
  if (allowed === "*") return true;
  if (allowed === candidate) return true;
  if (allowed.endsWith("*") && candidate.startsWith(allowed.slice(0, -1))) return true;
  try {
    const allowedUrl = new URL(allowed);
    if (allowedUrl.origin === candidateUrl.origin && allowedUrl.pathname.startsWith("/r/") && candidateUrl.pathname.startsWith("/r/")) {
      return true;
    }
  } catch { /* ignore invalid allowlist entry */ }
  return false;
}
function clientAllowsRedirect(client: OAuthClient, value: string): boolean {
  if (!isValidRedirectUri(value)) return false;
  const candidateUrl = new URL(value);
  if (client.redirect_uris.some((allowed) => matchesAllowedRedirect(allowed, value, candidateUrl))) {
    return true;
  }
  // Static MCP clients registered in Gemini/Google apps receive per-app callback
  // paths under https://oauth-redirect.googleusercontent.com/r/<app-id>.
  if (
    client.is_static &&
    candidateUrl.origin === "https://oauth-redirect.googleusercontent.com" &&
    candidateUrl.pathname.startsWith("/r/")
  ) {
    return true;
  }
  return false;
}
async function key(env: Env): Promise<CryptoKey> {
  if (!env.MCP_TOKEN) throw new Error("MCP_TOKEN is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.MCP_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
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
  data.forEach((value, name) => { if (typeof value === "string") result[name] = value; });
  return result;
}
async function registryCall(env: Env, body: Record<string, unknown>): Promise<any> {
  const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("global"));
  const response = await stub.fetch("https://registry/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error ?? "OAuth registry operation failed");
  return data.result;
}
async function resolveClient(env: Env, id: string): Promise<OAuthClient | null> {
  if (!id) return null;
  if (env.MCP_OAUTH_CLIENT_ID && equal(id, env.MCP_OAUTH_CLIENT_ID)) {
    return {
      client_id: env.MCP_OAUTH_CLIENT_ID,
      client_name: "Configured MCP client",
      token_endpoint_auth_method: env.MCP_OAUTH_CLIENT_SECRET ? "client_secret_basic" : "none",
      client_secret: env.MCP_OAUTH_CLIENT_SECRET,
      redirect_uris: redirects(env),
      is_static: true
    };
  }
  try {
    const stored = await registryCall(env, { action: "getOAuthClient", client_id: id });
    if (stored && typeof stored.client_id === "string" && Array.isArray(stored.redirect_uris)) {
      return stored as OAuthClient;
    }
  } catch { /* fall through */ }
  return null;
}
async function authenticateClient(client: OAuthClient, secret: string): Promise<boolean> {
  if (client.token_endpoint_auth_method === "none") return true;
  if (client.client_secret) return !!secret && equal(secret, client.client_secret);
  if (client.client_secret_hash) return !!secret && equal(await sha256Hex(secret), client.client_secret_hash);
  return false;
}
async function registryGrant(env: Env, action: "storeOAuthGrant" | "consumeOAuthGrant", jti: string, grantType: "code" | "refresh", expiresAt?: number): Promise<boolean> {
  const result = await registryCall(env, { action, jti, grant_type: grantType, ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) });
  return action === "storeOAuthGrant" ? result?.stored === true : result?.consumed === true;
}
async function issueTokens(env: Env, clientId: string) {
  const now = Math.floor(Date.now() / 1000), refreshJti = randomId();
  const access_token = await sign(env, { typ: "access", sub: clientId, scope: "mcp:tools", exp: now + 86400, jti: randomId() });
  await registryGrant(env, "storeOAuthGrant", refreshJti, "refresh", (now + 2592000) * 1000);
  const refresh_token = await sign(env, { typ: "refresh", sub: clientId, exp: now + 2592000, jti: refreshJti });
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
    return claims.typ === "access" && !!claims.sub && claims.scope === "mcp:tools" && claims.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
export async function handleOAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/register" && request.method === "POST") {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: "invalid_client_metadata" }, 400); }
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (uris.length === 0 || uris.some((uri: unknown) => typeof uri !== "string" || !isValidRedirectUri(uri))) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    const authMethod = String(body?.token_endpoint_auth_method ?? "none");
    if (!["none", "client_secret_basic", "client_secret_post"].includes(authMethod)) {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    const clientId = "dcr_" + randomId();
    const clientName = String(body?.client_name ?? "Dynamic MCP client").slice(0, 128);
    const clientSecret = authMethod === "none" ? undefined : randomId();
    const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : undefined;
    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
    await registryCall(env, {
      action: "registerOAuthClient",
      client_id: clientId,
      client_name: clientName,
      token_endpoint_auth_method: authMethod,
      client_secret_hash: clientSecretHash ?? null,
      redirect_uris: uris,
      expires_at: expiresAt
    });
    return json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:tools",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret } : {})
    }, 201);
  }
  if (url.pathname === "/authorize" && request.method === "GET") {
    const p = url.searchParams, clientId = p.get("client_id") ?? "", redirect = p.get("redirect_uri") ?? "";
    const client = await resolveClient(env, clientId);
    if (p.get("response_type") !== "code" || !client || !clientAllowsRedirect(client, redirect) ||
        !p.get("code_challenge") || p.get("code_challenge_method") !== "S256") {
      return new Response("Invalid OAuth request: client, redirect URI and PKCE S256 are required", { status: 400 });
    }
    const csrf = randomId();
    const html = '<!doctype html><meta charset="utf-8"><title>Authorize LocalMCP Hub</title><h1>Authorize LocalMCP Hub</h1><p>Client: ' +
      escapeHtml(client.client_name) + ' (<code>' + escapeHtml(clientId) + '</code>)</p><p>Redirect: <code>' + escapeHtml(redirect) + '</code></p>' +
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
    const b = await form(request), cookie = request.headers.get("Cookie") ?? "", match = /(?:^|;\s*)hub_oauth_csrf=([^;]+)/.exec(cookie);
    if (!match || !equal(match[1] ?? "", b.csrf ?? "") || !env.MCP_TOKEN || !equal(b.approval_token ?? "", env.MCP_TOKEN)) {
      return new Response("Authorization denied", { status: 403 });
    }
    const clientId = b.client_id ?? "", redirect = b.redirect_uri ?? "";
    const client = await resolveClient(env, clientId);
    if (!client || !clientAllowsRedirect(client, redirect) || !b.code_challenge || (!b.state && b.state !== "")) {
      return new Response("Invalid OAuth authorization", { status: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    const codeJti = randomId();
    await registryGrant(env, "storeOAuthGrant", codeJti, "code", (now + 300) * 1000);
    const code = await sign(env, { typ: "code", sub: clientId, exp: now + 300, redirect_uri: redirect, challenge: b.code_challenge, state: b.state, jti: codeJti });
    const target = new URL(redirect); target.searchParams.set("code", code); if (b.state) target.searchParams.set("state", b.state);
    return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "Set-Cookie": "hub_oauth_csrf=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0" } });
  }
  if (url.pathname === "/token" && request.method === "POST") {
    const b = await form(request);
    let clientId = b.client_id ?? "", clientSecret = b.client_secret ?? "";
    const basic = request.headers.get("Authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    if (basic) {
      try { const decoded = atob(basic); const i = decoded.indexOf(":"); clientId = decoded.slice(0, i); clientSecret = decoded.slice(i + 1); }
      catch { return json({ error: "invalid_client" }, 401); }
    }
    const client = await resolveClient(env, clientId);
    if (!client || !await authenticateClient(client, clientSecret)) return json({ error: "invalid_client" }, 401);
    if (b.grant_type === "authorization_code") {
      const claims = await verify(env, b.code ?? "");
      if (!claims || claims.typ !== "code" || claims.sub !== clientId || claims.redirect_uri !== b.redirect_uri ||
          !clientAllowsRedirect(client, b.redirect_uri ?? "") || !claims.challenge || await pkce(b.code_verifier ?? "") !== claims.challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      if (!await registryGrant(env, "consumeOAuthGrant", claims.jti, "code")) return json({ error: "invalid_grant" }, 400);
      return json(await issueTokens(env, clientId));
    }
    if (b.grant_type === "refresh_token") {
      const claims = await verify(env, b.refresh_token ?? "");
      if (!claims || claims.typ !== "refresh" || claims.sub !== clientId ||
          !await registryGrant(env, "consumeOAuthGrant", claims.jti, "refresh")) return json({ error: "invalid_grant" }, 400);
      return json(await issueTokens(env, clientId));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  return new Response("Method Not Allowed", { status: 405 });
}

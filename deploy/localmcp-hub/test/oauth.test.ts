import { describe, expect, it } from "vitest";
import { handleOAuthRequest, verifyOAuthAccessToken } from "../src/oauth";
import type { Env } from "../src/types";

const grants = new Map<string, string>();
const clients = new Map<string, any>();
const registryStub = {
  async fetch(_input: any, init: any) {
    const body = JSON.parse(String(init.body));
    if (body.action === "storeOAuthGrant") { grants.set(body.jti, body.grant_type); return Response.json({ result: { stored: true } }); }
    if (body.action === "consumeOAuthGrant") {
      const found = grants.get(body.jti) === body.grant_type;
      if (found) grants.delete(body.jti);
      return Response.json({ result: { consumed: found } });
    }
    if (body.action === "registerOAuthClient") {
      clients.set(body.client_id, {
        client_id: body.client_id,
        client_name: body.client_name,
        token_endpoint_auth_method: body.token_endpoint_auth_method,
        ...(body.client_secret_hash ? { client_secret_hash: body.client_secret_hash } : {}),
        redirect_uris: body.redirect_uris
      });
      return Response.json({ result: { registered: true } });
    }
    if (body.action === "getOAuthClient") {
      return Response.json({ result: clients.get(body.client_id) ?? null });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  }
};
const env = {
  MCP_TOKEN: "mcp-static-token",
  MCP_OAUTH_CLIENT_ID: "connector-client",
  MCP_OAUTH_CLIENT_SECRET: "connector-secret",
  MCP_OAUTH_REDIRECT_URIS: '["https://connector.example/callback"]',
  REGISTRY_DO: { idFromName: () => "global", get: () => registryStub }
} as unknown as Env;

async function pkcePair(verifier: string) {
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = ""; for (const byte of challengeBytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

describe("Hub OAuth", () => {
  it("issues a PKCE-bound access token for an allowlisted redirect and validates it", async () => {
    const verifier = "a".repeat(64);
    const challenge = await pkcePair(verifier);
    const authorize = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fconnector.example%2Fcallback&code_challenge=" + challenge + "&code_challenge_method=S256&state=state-1"), env);
    expect(authorize.status).toBe(200);
    const cookie = authorize.headers.get("Set-Cookie")!.split(";")[0]!;
    const html = await authorize.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const form = new URLSearchParams({
      csrf, client_id: "connector-client", redirect_uri: "https://connector.example/callback",
      state: "state-1", code_challenge: challenge, approval_token: "mcp-static-token"
    });
    const approved = await handleOAuthRequest(new Request("https://hub.example/authorize", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form }), env);
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code", client_id: "connector-client", client_secret: "connector-secret",
      code, redirect_uri: "https://connector.example/callback", code_verifier: verifier
    });
    const tokenResponse = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenForm }), env);
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as any;
    expect(await verifyOAuthAccessToken(tokens.access_token, env.MCP_TOKEN)).toBe(true);
    expect(await verifyOAuthAccessToken(tokens.access_token + "tampered", env.MCP_TOKEN)).toBe(false);
    const replay = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenForm }), env);
    expect(replay.status).toBe(400);
    const refreshForm = new URLSearchParams({ grant_type: "refresh_token", client_id: "connector-client", client_secret: "connector-secret", refresh_token: tokens.refresh_token });
    const refreshed = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshForm }), env);
    expect(refreshed.status).toBe(200);
    const refreshReplay = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshForm }), env);
    expect(refreshReplay.status).toBe(400);
  });

  it("supports Dynamic Client Registration (DCR) with PKCE and token_endpoint_auth_method=none", async () => {
    const regRes = await handleOAuthRequest(new Request("https://hub.example/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT App",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "none"
      })
    }), env);
    expect(regRes.status).toBe(201);
    const registered = await regRes.json() as any;
    expect(registered.client_id).toMatch(/^dcr_/);

    const verifier = "b".repeat(64);
    const challenge = await pkcePair(verifier);
    const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const authorize = await handleOAuthRequest(new Request(
      `https://hub.example/authorize?response_type=code&client_id=${encodeURIComponent(registered.client_id)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=s2`
    ), env);
    expect(authorize.status).toBe(200);
    const cookie = authorize.headers.get("Set-Cookie")!.split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await authorize.text())![1]!;
    const approved = await handleOAuthRequest(new Request("https://hub.example/authorize", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, client_id: registered.client_id, redirect_uri: redirect, state: "s2", code_challenge: challenge, approval_token: "mcp-static-token" })
    }), env);
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;

    const tokenRes = await handleOAuthRequest(new Request("https://hub.example/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code, redirect_uri: redirect, code_verifier: verifier })
    }), env);
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as any;
    expect(await verifyOAuthAccessToken(tokens.access_token, env.MCP_TOKEN)).toBe(true);
  });

  it("allows per-app Google/Gemini custom MCP redirect URIs for the static client", async () => {
    const redirect = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-13b675fb5285e81468d9a6ef";
    const challenge = await pkcePair("c".repeat(64));
    const response = await handleOAuthRequest(new Request(
      `https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=s3`
    ), env);
    expect(response.status).toBe(200);
  });

  it("rejects redirect URIs outside the configured allowlist", async () => {
    const response = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback&code_challenge=x&code_challenge_method=S256"), env);
    expect(response.status).toBe(400);
  });
});

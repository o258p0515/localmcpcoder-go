import { describe, expect, it } from "vitest";
import { handleOAuthRequest, verifyOAuthAccessToken } from "../src/oauth";
import type { Env } from "../src/types";
const grants = new Map<string, string>();
const registryStub = { async fetch(_input: any, init: any) {
  const body = JSON.parse(String(init.body));
  if (body.action === "storeOAuthGrant") { grants.set(body.jti, body.grant_type); return Response.json({ result: { stored: true } }); }
  if (body.action === "consumeOAuthGrant") {
    const found = grants.get(body.jti) === body.grant_type;
    if (found) grants.delete(body.jti);
    return Response.json({ result: { consumed: found } });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
} };
const env = { MCP_TOKEN: "mcp-static-token", HUB_SHARED_SECRET: "hub-signing-secret",
  MCP_OAUTH_CLIENT_ID: "connector-client", MCP_OAUTH_CLIENT_SECRET: "connector-secret",
  MCP_OAUTH_REDIRECT_URIS: '["https://connector.example/callback"]',
  REGISTRY_DO: { idFromName: () => "global", get: () => registryStub } } as unknown as Env;
const challenge = "a".repeat(43);
describe("Hub OAuth", () => {
  it("issues a PKCE-bound access token for an allowlisted redirect and validates it", async () => {
    const verifier = "a".repeat(64);
    const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    let binary = ""; for (const byte of challengeBytes) binary += String.fromCharCode(byte);
    const validChallenge = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const authorize = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fconnector.example%2Fcallback&code_challenge=" + validChallenge + "&code_challenge_method=S256&state=state-1"), env);
    expect(authorize.status).toBe(200);
    const cookie = authorize.headers.get("Set-Cookie")!.split(";")[0]!;
    const html = await authorize.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const form = new URLSearchParams({ csrf, client_id: "connector-client", redirect_uri: "https://connector.example/callback",
      state: "state-1", code_challenge: validChallenge, approval_token: "mcp-static-token" });
    const approved = await handleOAuthRequest(new Request("https://hub.example/authorize", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form }), env);
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
    const tokenForm = new URLSearchParams({ grant_type: "authorization_code", client_id: "connector-client", client_secret: "connector-secret",
      code, redirect_uri: "https://connector.example/callback", code_verifier: verifier });
    const tokenResponse = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenForm }), env);
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as any;
    expect(await verifyOAuthAccessToken(tokens.access_token, env.HUB_SHARED_SECRET)).toBe(true);
    expect(await verifyOAuthAccessToken(tokens.access_token + "tampered", env.HUB_SHARED_SECRET)).toBe(false);
    const replay = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tokenForm }), env);
    expect(replay.status).toBe(400);
    const refreshForm = new URLSearchParams({ grant_type: "refresh_token", client_id: "connector-client", client_secret: "connector-secret", refresh_token: tokens.refresh_token });
    const refreshed = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshForm }), env);
    expect(refreshed.status).toBe(200);
    const refreshReplay = await handleOAuthRequest(new Request("https://hub.example/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshForm }), env);
    expect(refreshReplay.status).toBe(400);
  });
  it("rejects redirect URIs outside the configured allowlist", async () => {
    const response = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback&code_challenge=" + challenge + "&code_challenge_method=S256"), env);
    expect(response.status).toBe(400);
  });
  it("accepts any HTTPS redirect when wildcard mode is explicitly configured", async () => {
    const wildcardEnv = { ...env, MCP_OAUTH_REDIRECT_URIS: "*" } as Env;
    const response = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fdynamic.example%2Foauth%2Fcallback&code_challenge=" + challenge + "&code_challenge_method=S256"), wildcardEnv);
    expect(response.status).toBe(200);
  });
  it("rejects non-HTTPS arbitrary redirects even in wildcard mode", async () => {
    const wildcardEnv = { ...env, MCP_OAUTH_REDIRECT_URIS: "*" } as Env;
    const response = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=http%3A%2F%2Fevil.example%2Fcallback&code_challenge=" + challenge + "&code_challenge_method=S256"), wildcardEnv);
    expect(response.status).toBe(400);
  });
  it("rejects malformed S256 challenges", async () => {
    const response = await handleOAuthRequest(new Request("https://hub.example/authorize?response_type=code&client_id=connector-client&redirect_uri=https%3A%2F%2Fconnector.example%2Fcallback&code_challenge=x&code_challenge_method=S256"), env);
    expect(response.status).toBe(400);
  });
});

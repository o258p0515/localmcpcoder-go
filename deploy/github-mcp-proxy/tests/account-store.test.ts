import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAccounts, listPublicAccounts, resolveAccount, clearAccountCaches } from "../src/rtdb/account-store";

function makeKV() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key)
  } as any;
}
function env(extra: any = {}) {
  return {
    MCP_TOKEN: "unit-test-secret",
    RTDB_AUTH_URL: "https://unit.firebaseio.com/github_accounts.json?auth=unit-auth",
    CACHE_KV: makeKV(),
    OAUTH_KV: makeKV(),
    ...extra
  } as any;
}
const defaultData = {
  personal: { username: "me", token: "ghp_never-leak", enabled: true, orgs: ["org"] },
  disabled: { username: "off", token: "ghp_disabled", enabled: false }
};

describe("Firebase account store", () => {
  beforeEach(async () => {
    await clearAccountCaches(env());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(defaultData)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads legacy RTDB auth and encrypts cached PATs", async () => {
    const e = env();
    const accounts = await getAccounts(e);
    expect(accounts["personal"]!.token).toBe("ghp_never-leak");
    const cached = e.CACHE_KV.values.get("rtdb:accounts:v1");
    expect(cached).toBeTruthy();
    expect(cached).not.toContain("ghp_never-leak");
    const publicAccounts = await listPublicAccounts(e);
    expect(publicAccounts).toHaveLength(1);
    expect(publicAccounts[0]).not.toHaveProperty("token");
  });

  it("never falls back to another account for a bad alias", async () => {
    const result = await resolveAccount(env(), "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.availableAccounts.map(account => account.alias)).toEqual(["personal"]);
  });

  it("clears both account and tool catalogue caches", async () => {
    const e = env();
    await getAccounts(e);
    await e.CACHE_KV.put("mcp:tools_catalog:v1", "[]");
    await clearAccountCaches(e);
    expect(e.CACHE_KV.values.has("rtdb:accounts:v1")).toBe(false);
    expect(e.CACHE_KV.values.has("mcp:tools_catalog:v1")).toBe(false);
  });

  it("falls back to /env/github_accounts when the direct node is empty", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      return url.includes("/env/github_accounts.json")
        ? Response.json({ personal: { username: "me", token: "ghp_env_path", enabled: true } })
        : Response.json(null);
    }));
    const e = env({ RTDB_AUTH_URL: "https://unit.firebaseio.com/?auth=unit-auth" });
    const accounts = await getAccounts(e);
    expect(accounts["personal"]!.token).toBe("ghp_env_path");
    expect(calls.map(url => new URL(url).pathname)).toEqual(["/github_accounts.json", "/env/github_accounts.json"]);
  });

  it("uses Base64 Service Account before raw JSON and authenticates RTDB with OAuth", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let binary = "";
    for (const byte of der) binary += String.fromCharCode(byte);
    const privateKey = "-----BEGIN PRIVATE KEY-----\\n" + btoa(binary).match(/.{1,64}/g)!.join("\\n") + "\\n-----END PRIVATE KEY-----";
    const serviceAccount = {
      type: "service_account",
      client_email: "worker@example.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: "https://oauth2.googleapis.com/token"
    };
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "google-access", expires_in: 3600 });
      return Response.json({ personal: { username: "me", token: "ghp_pat", enabled: true } });
    }));
    const e = env({
      FIREBASE_SERVICE_ACCOUNT_JSON_B64: btoa(JSON.stringify(serviceAccount)),
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "invalid" }),
      RTDB_URL: "https://unit.firebaseio.com/github_accounts.json",
      RTDB_AUTH_URL: ""
    });
    const accounts = await getAccounts(e);
    expect(accounts["personal"]!.token).toBe("ghp_pat");
    const rtdb = calls.find(call => call.url.includes("github_accounts.json"))!;
    expect(rtdb.init.headers.get("Authorization")).toBe("Bearer google-access");
    expect(rtdb.url).not.toContain("auth=");
  });
});
import type { Env, RtdbAccount } from "../types";
import { decryptAesGcm, encryptAesGcm } from "../utils/crypto";
import { googleAccessToken, resolveServiceAccountFromEnv } from "./google-jwt";

let memory: { accounts: Record<string, RtdbAccount>; expires: number } | null = null;

function normalizeDbUrl(raw: string, removeAuth = false): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !(/\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname))) {
    throw new Error("RTDB URL must use HTTPS and a Firebase database hostname");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/github_accounts.json";
  else if (url.pathname === "/github_accounts") url.pathname += ".json";
  else if (!url.pathname.endsWith(".json")) throw new Error("RTDB URL path must point to github_accounts.json");
  if (removeAuth) url.searchParams.delete("auth");
  return url.toString();
}

function normalize(raw: unknown): Record<string, RtdbAccount> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("RTDB github_accounts node must be a JSON object");
  const out: Record<string, RtdbAccount> = {};
  for (const [alias, value] of Object.entries(raw)) {
    const account = value as Partial<RtdbAccount>;
    if (!account || typeof account.token !== "string" || !account.token.trim()) continue;
    out[alias] = {
      username: String(account.username || ""),
      token: account.token,
      description: String(account.description || ""),
      orgs: Array.isArray(account.orgs) ? account.orgs.map(String) : [],
      enabled: account.enabled !== false,
      readonly: account.readonly === true,
      is_catalog_source: account.is_catalog_source === true
    };
  }
  return out;
}

export async function getAccounts(env: Env, options: { forceRefresh?: boolean } = {}): Promise<Record<string, RtdbAccount>> {
  const ttl = Math.max(30, Number(env.RTDB_CACHE_TTL_SECONDS) || 300);
  if (!options.forceRefresh && memory && memory.expires > Date.now()) return memory.accounts;
  if (!options.forceRefresh) {
    const cached = await env.CACHE_KV.get("rtdb:accounts:v1");
    if (cached) {
      try {
        const accounts = JSON.parse(await decryptAesGcm(cached, env.MCP_TOKEN));
        memory = { accounts, expires: Date.now() + ttl * 1000 };
        return accounts;
      } catch {
        // A changed MCP_TOKEN makes old encrypted cache entries unreadable; fetch fresh data.
      }
    }
  }

  const serviceAccount = resolveServiceAccountFromEnv(env);
  const headers = new Headers();
  let url: string;
  if (serviceAccount) {
    const rawUrl = env.RTDB_URL?.trim() || env.RTDB_AUTH_URL?.trim() || "";
    if (!rawUrl) throw new Error("RTDB_URL or RTDB_AUTH_URL is required with a Firebase Service Account");
    url = normalizeDbUrl(rawUrl, true);
    headers.set("Authorization", "Bearer " + await googleAccessToken(env));
  } else {
    const rawUrl = env.RTDB_AUTH_URL?.trim() || "";
    if (!rawUrl) throw new Error("RTDB is not configured: provide Firebase Service Account + RTDB_URL or RTDB_AUTH_URL");
    url = normalizeDbUrl(rawUrl);
    if (!new URL(url).searchParams.get("auth")) throw new Error("RTDB_AUTH_URL must include ?auth= when Service Account credentials are not configured");
  }

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Firebase RTDB request failed (HTTP " + response.status + ")");
  const accounts = normalize(await response.json());
  if (!Object.values(accounts).some(account => account.enabled)) throw new Error("Firebase RTDB contains no enabled GitHub account with a token");

  memory = { accounts, expires: Date.now() + ttl * 1000 };
  await env.CACHE_KV.put("rtdb:accounts:v1", await encryptAesGcm(JSON.stringify(accounts), env.MCP_TOKEN), { expirationTtl: ttl });
  return accounts;
}

export async function listPublicAccounts(env: Env) {
  const accounts = await getAccounts(env);
  return Object.entries(accounts)
    .filter(([, account]) => account.enabled)
    .map(([alias, account]) => ({
      alias, username: account.username, description: account.description,
      orgs: account.orgs, readonly: account.readonly
    }));
}

export async function resolveAccount(env: Env, alias: string) {
  const accounts = await getAccounts(env);
  const availableAccounts = Object.entries(accounts)
    .filter(([, account]) => account.enabled)
    .map(([key, account]) => ({
      alias: key, username: account.username, description: account.description,
      orgs: account.orgs, readonly: account.readonly
    }));
  const account = accounts[alias];
  return account?.enabled
    ? { ok: true as const, account }
    : { ok: false as const, reason: "invalid_or_missing", availableAccounts };
}

export async function clearAccountCaches(env: Env) {
  memory = null;
  await Promise.all(["rtdb:accounts:v1", "mcp:tools_catalog:v1"].map(key => env.CACHE_KV.delete(key)));
}
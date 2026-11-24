import { describe, expect, it, vi } from "vitest";
import { RegistryDO } from "../src/registry-do";
import type { Env } from "../src/types";

class RegistrySQL {
  runners = new Map<string, any>();
  sessions = new Map<string, string>();
  grants = new Map<string, { grant_type: string; expires_at: number }>();
  clients = new Map<string, any>();
  exec(query: string, ...args: any[]) {
    if (query.startsWith("INSERT INTO runners")) {
      const [id, os, arch, repo, tags_json, connected_at] = args;
      this.runners.set(id, { runner_id: id, os, arch, repo, tags_json, status: "online", connected_at });
      return { rowsWritten: 1, toArray: () => [] };
    }
    if (query.startsWith("DELETE FROM runners")) {
      const removed = this.runners.delete(args[0]);
      return { rowsWritten: removed ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("DELETE FROM session_targets")) {
      let count = 0; for (const [key, id] of this.sessions) if (id === args[0]) { this.sessions.delete(key); count++; }
      return { rowsWritten: count, toArray: () => [] };
    }
    if (query.startsWith("UPDATE runners SET status")) {
      const row = this.runners.get(args[1]); if (row) row.status = args[0];
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("SELECT * FROM runners ORDER BY")) {
      return { rowsWritten: 0, toArray: () => [...this.runners.values()].sort((a,b) => b.connected_at-a.connected_at) };
    }
    if (query.startsWith("SELECT * FROM runners WHERE")) {
      const row = this.runners.get(args[0]); return { rowsWritten: 0, toArray: () => row ? [row] : [] };
    }
    if (query.startsWith("SELECT runner_id FROM session_targets")) {
      const id = this.sessions.get(args[0]); return { rowsWritten: 0, toArray: () => id ? [{ runner_id: id }] : [] };
    }
    if (query.startsWith("DELETE FROM oauth_grants WHERE expires_at")) {
      let count = 0; for (const [jti, grant] of this.grants) if (grant.expires_at <= args[0]) { this.grants.delete(jti); count++; }
      return { rowsWritten: count, toArray: () => [] };
    }
    if (query.startsWith("INSERT INTO oauth_grants")) {
      this.grants.set(args[0], { grant_type: args[1], expires_at: args[2] }); return { rowsWritten: 1, toArray: () => [] };
    }
    if (query.startsWith("SELECT jti FROM oauth_grants")) {
      const grant = this.grants.get(args[0]); return { rowsWritten: 0, toArray: () => grant && grant.grant_type === args[1] && grant.expires_at > args[2] ? [{ jti: args[0] }] : [] };
    }
    if (query.startsWith("DELETE FROM oauth_grants WHERE jti")) {
      const deleted = this.grants.delete(args[0]); return { rowsWritten: deleted ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("DELETE FROM oauth_clients WHERE expires_at")) {
      let count = 0; for (const [id, client] of this.clients) if (client.expires_at <= args[0]) { this.clients.delete(id); count++; }
      return { rowsWritten: count, toArray: () => [] };
    }
    if (query.startsWith("INSERT OR REPLACE INTO oauth_clients")) {
      const [client_id, client_name, token_endpoint_auth_method, client_secret_hash, redirect_uris_json, created_at, expires_at] = args;
      this.clients.set(client_id, { client_id, client_name, token_endpoint_auth_method, client_secret_hash, redirect_uris_json, created_at, expires_at });
      return { rowsWritten: 1, toArray: () => [] };
    }
    if (query.startsWith("SELECT client_id,client_name")) {
      const client = this.clients.get(args[0]);
      return { rowsWritten: 0, toArray: () => client && client.expires_at > args[1] ? [client] : [] };
    }
    if (query.startsWith("INSERT INTO session_targets")) {
      this.sessions.set(args[0], args[1]); return { rowsWritten: 1, toArray: () => [] };
    }
    return { rowsWritten: 0, toArray: () => [] };
  }
}
function makeRegistry() {
  const sql = new RegistrySQL();
  const state = { storage: { sql } };
  return { registry: new RegistryDO(state as any, {} as Env), sql };
}
async function action(registry: RegistryDO, body: Record<string, unknown>) {
  return registry.fetch(new Request("https://registry/internal", { method: "POST", body: JSON.stringify(body) }));
}
describe("RegistryDO", () => {
  it("registers and updates runner metadata", async () => {
    const { registry } = makeRegistry();
    const response = await action(registry, { action: "register", runner_id: "r1", os: "linux", arch: "amd64", repo: "o/r", tags: ["go"] });
    expect((await response.json() as any).result).toMatchObject({ runner_id: "r1", status: "online", tags: ["go"] });
  });
  it("unregisters a runner and clears its session targets", async () => {
    const { registry, sql } = makeRegistry();
    await action(registry, { action: "register", runner_id: "r1", os: "linux", arch: "amd64" });
    await action(registry, { action: "setSessionRunner", session_key: "s1", runner_id: "r1" });
    const response = await action(registry, { action: "unregister", runner_id: "r1" });
    expect((await response.json() as any).result.removed).toBe(true);
    expect(sql.sessions.size).toBe(0);
  });
  it("sets only supported runner states", async () => {
    const { registry } = makeRegistry();
    await action(registry, { action: "register", runner_id: "r1", os: "linux", arch: "amd64" });
    expect((await (await action(registry, { action: "setStatus", runner_id: "r1", status: "draining" })).json() as any).result.status).toBe("draining");
    expect((await action(registry, { action: "setStatus", runner_id: "r1", status: "broken" })).status).toBe(500);
  });
  it("pins a session to an online runner and rejects an offline one", async () => {
    const { registry } = makeRegistry();
    await action(registry, { action: "register", runner_id: "r1", os: "linux", arch: "amd64" });
    expect((await (await action(registry, { action: "setSessionRunner", session_key: "s1", runner_id: "r1" })).json() as any).result).toEqual({ session_key: "s1", runner_id: "r1" });
    await action(registry, { action: "setStatus", runner_id: "r1", status: "draining" });
    expect((await action(registry, { action: "setSessionRunner", session_key: "s2", runner_id: "r1" })).status).toBe(500);
  });
  it("consumes OAuth grants exactly once", async () => {
    const { registry, sql } = makeRegistry();
    const expiry = Date.now() + 60_000;
    expect((await (await action(registry, { action: "storeOAuthGrant", jti: "code-1", grant_type: "code", expires_at: expiry })).json() as any).result.stored).toBe(true);
    expect((await (await action(registry, { action: "consumeOAuthGrant", jti: "code-1", grant_type: "code" })).json() as any).result.consumed).toBe(true);
    expect((await (await action(registry, { action: "consumeOAuthGrant", jti: "code-1", grant_type: "code" })).json() as any).result.consumed).toBe(false);
    expect(sql.grants.size).toBe(0);
  });
  it("stores and retrieves DCR OAuth clients", async () => {
    const { registry } = makeRegistry();
    const expiry = Date.now() + 60_000;
    const reg = await action(registry, {
      action: "registerOAuthClient",
      client_id: "dcr_abc",
      client_name: "ChatGPT App",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      expires_at: expiry
    });
    expect((await reg.json() as any).result.registered).toBe(true);
    const fetched = await action(registry, { action: "getOAuthClient", client_id: "dcr_abc" });
    expect((await fetched.json() as any).result).toMatchObject({
      client_id: "dcr_abc",
      client_name: "ChatGPT App",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"]
    });
  });
  it("resolves runner list and selected session in one combined action", async () => {
    const { registry } = makeRegistry();
    await action(registry, { action: "register", runner_id: "r1", os: "linux", arch: "amd64" });
    await action(registry, { action: "setSessionRunner", session_key: "s1", runner_id: "r1" });
    const response = await action(registry, { action: "resolveContext", session_key: "s1" });
    expect((await response.json() as any).result).toMatchObject({
      runners: [{ runner_id: "r1", status: "online" }],
      selected_runner: "r1"
    });
  });
  it("lists runners in most-recently-connected order", async () => {
    const { registry } = makeRegistry();
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(200);
    await action(registry, { action: "register", runner_id: "older", os: "linux", arch: "amd64" });
    await action(registry, { action: "register", runner_id: "newer", os: "linux", arch: "arm64" });
    const result = await (await action(registry, { action: "listRunners" })).json() as any;
    expect(result.result.map((r: any) => r.runner_id)).toEqual(["newer", "older"]);
    clock.mockRestore();
  });
});
  152
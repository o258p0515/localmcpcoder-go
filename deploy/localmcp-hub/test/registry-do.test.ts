import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryDO } from "../src/registry-do";
import type { Env } from "../src/types";

class RegistrySQL {
  runners = new Map<string, any>();
  sessions = new Map<string, string>();
  grants = new Map<string, { grant_type: string; expires_at: number }>();
  clients = new Map<string, any>();
  exec(query: string, ...args: any[]) {
    if (query.startsWith("ALTER TABLE")) {
      return { rowsWritten: 0, toArray: () => [] };
    }
    if (query.startsWith("INSERT INTO runners")) {
      const [id, os, arch, repo, tags_json, connected_at, provider, account, expires_at, predecessor_id, generation, handover_after, idle_timeout] = args;
      this.runners.set(id, {
        runner_id: id,
        os,
        arch,
        repo,
        tags_json,
        status: "online",
        connected_at,
        provider: provider ?? "",
        account: account ?? "",
        expires_at: expires_at ?? null,
        handover_state: "none",
        predecessor_id: predecessor_id ?? "",
        successor_id: "",
        generation: generation ?? 1,
        handover_after: handover_after ?? 0,
        idle_timeout: idle_timeout ?? 0
      });
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
    if (query.startsWith("UPDATE session_targets SET runner_id=?")) {
      const [successorId, _updatedAt, predecessorId] = args;
      let count = 0;
      for (const [key, id] of this.sessions) {
        if (id === predecessorId) {
          this.sessions.set(key, successorId);
          count++;
        }
      }
      return { rowsWritten: count, toArray: () => [] };
    }
    if (query.startsWith("UPDATE runners SET status='draining',handover_state='cutover_done'")) {
      const [successorId, predecessorId] = args;
      const row = this.runners.get(predecessorId);
      if (row) {
        row.status = "draining";
        row.handover_state = "cutover_done";
        row.successor_id = successorId;
      }
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("UPDATE runners SET handover_state='spawning',successor_id=?")) {
      const [successorId, runnerId] = args;
      const row = this.runners.get(runnerId);
      if (row) {
        row.handover_state = "spawning";
        row.successor_id = successorId;
      }
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("UPDATE runners SET handover_state='")) {
      const match = query.match(/handover_state='([^']+)'/);
      const row = this.runners.get(args[0]);
      if (row && match) row.handover_state = match[1];
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("UPDATE runners SET status=?")) {
      const row = this.runners.get(args[1]); if (row) row.status = args[0];
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("SELECT * FROM runners ORDER BY")) {
      return { rowsWritten: 0, toArray: () => [...this.runners.values()].sort((a, b) => b.connected_at - a.connected_at) };
    }
    if (query.startsWith("SELECT * FROM runners WHERE")) {
      const row = this.runners.get(args[0]); return { rowsWritten: 0, toArray: () => row ? [{ ...row }] : [] };
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

function makeRegistry(
  envOverrides: Partial<Env> = {},
  activityByRunner: Record<string, { has_activity: boolean; last_activity_at: number | null; active_requests: number }> = {}
) {
  const sql = new RegistrySQL();
  const alarms: number[] = [];
  const shutdownCalls: Array<{ runnerId: string; body: any }> = [];
  const state = {
    storage: {
      sql,
      setAlarm: async (ts: number) => { alarms.push(ts); }
    }
  };
  const env = {
    MCP_TOKEN: "test-mcp-token-0123456789abcdef",
    RUNNER_DO: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (String(url).endsWith("/activity")) {
            const act = activityByRunner[id];
            if (act) return Response.json({ result: { runner_id: id, ...act } });
            return Response.json({ result: { runner_id: id, has_activity: true, last_activity_at: Date.now(), active_requests: 0 } });
          }
          shutdownCalls.push({ runnerId: id, body: JSON.parse(String(init?.body ?? "{}")) });
          return Response.json({ result: { notified: 1 } });
        }
      })
    },
    ...envOverrides
  } as unknown as Env;
  return { registry: new RegistryDO(state as any, env), sql, alarms, shutdownCalls };
}

async function action(registry: RegistryDO, body: Record<string, unknown>) {
  return registry.fetch(new Request("https://registry/internal", { method: "POST", body: JSON.stringify(body) }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RegistryDO", () => {
  it("registers and updates runner metadata including lease fields", async () => {
    const { registry, alarms } = makeRegistry();
    const response = await action(registry, {
      action: "register",
      runner_id: "r1",
      os: "linux",
      arch: "amd64",
      repo: "o/r",
      tags: ["provider:github", "account:personal", "go", "agent"],
      duration_seconds: 3600
    });
    const result = (await response.json() as any).result;
    expect(result).toMatchObject({
      runner_id: "r1",
      status: "online",
      provider: "github",
      account: "personal",
      handover_state: "none",
      generation: 1
    });
    expect(result.expires_at).toBeGreaterThan(Date.now());
    expect(alarms.length).toBe(1);
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

  it("atomically migrates all session targets and shuts down predecessor on make-before-break cutover", async () => {
    const { registry, sql, shutdownCalls } = makeRegistry();
    await action(registry, { action: "register", runner_id: "gha-g1", os: "linux", arch: "amd64", tags: ["provider:github", "agent", "pair:p1"], generation: 1 });
    await action(registry, { action: "setSessionRunner", session_key: "default", runner_id: "gha-g1" });
    await action(registry, { action: "setSessionRunner", session_key: "session-a", runner_id: "gha-g1" });

    const reg2 = await action(registry, {
      action: "register",
      runner_id: "gha-g2",
      os: "linux",
      arch: "amd64",
      tags: ["provider:github", "agent", "pair:p1"],
      predecessor_id: "gha-g1",
      generation: 2
    });
    const reg2Body = (await reg2.json() as any).result;
    expect(reg2Body.cutover).toEqual({ predecessor_id: "gha-g1", migrated_sessions: 2 });
    expect(sql.sessions.get("default")).toBe("gha-g2");
    expect(sql.sessions.get("session-a")).toBe("gha-g2");

    const oldRunner = (await (await action(registry, { action: "getRunner", runner_id: "gha-g1" })).json() as any).result;
    expect(oldRunner).toMatchObject({ status: "draining", handover_state: "cutover_done", successor_id: "gha-g2" });
    expect(shutdownCalls).toEqual([{ runnerId: "gha-g1", body: { reason: "handover_complete", successor_id: "gha-g2" } }]);

    // Unregistering predecessor after drain must not delete migrated sessions.
    await action(registry, { action: "unregister", runner_id: "gha-g1" });
    expect(sql.sessions.get("default")).toBe("gha-g2");
    expect(sql.sessions.get("session-a")).toBe("gha-g2");
  });

  it("skips spawning replacement for persistent providers (instabox/upstashbox)", async () => {
    const { registry } = makeRegistry({ HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" });
    await action(registry, { action: "register", runner_id: "ub-1", os: "linux", arch: "arm64", tags: ["provider:upstashbox", "agent"] });
    const res = await action(registry, { action: "requestHandover", runner_id: "ub-1", reason: "quota_expiring" });
    expect((await res.json() as any).result).toMatchObject({ accepted: false, reason: "persistent_provider_uses_resume", provider: "upstashbox" });
  });

  it("enforces max_generations to prevent handover storms", async () => {
    const { registry } = makeRegistry({ HANDOVER_MAX_GENERATIONS: "3", HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" });
    await action(registry, { action: "register", runner_id: "gha-g3", os: "linux", arch: "amd64", tags: ["provider:github", "agent"], generation: 3 });
    const res = await action(registry, { action: "requestHandover", runner_id: "gha-g3", generation: 3 });
    expect((await res.json() as any).result).toMatchObject({ accepted: false, reason: "max_generations_reached", generation: 3, max_generations: 3 });
  });

  it("keeps predecessor online without shutdown when handover webhook fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "quota exhausted" }), { status: 503 })
    );
    const { registry, shutdownCalls } = makeRegistry({ HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" });
    await action(registry, { action: "register", runner_id: "gha-g1", os: "linux", arch: "amd64", tags: ["provider:github", "account:personal", "pair:p1", "run:123", "gen:1", "agent"] });
    const res = await action(registry, { action: "requestHandover", runner_id: "gha-g1", reason: "quota_expiring" });
    expect((await res.json() as any).result).toMatchObject({ accepted: false, reason: "spawn_failed" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const sentBody = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sentBody.tags).toContain("pair:p1");
    expect(sentBody.tags).not.toContain("run:123");
    expect(sentBody.tags).not.toContain("gen:1");

    const runner = (await (await action(registry, { action: "getRunner", runner_id: "gha-g1" })).json() as any).result;
    expect(runner.status).toBe("online");
    expect(runner.handover_state).toBe("failed");
    expect(shutdownCalls).toHaveLength(0);
  });

  it("triggers handover automatically from Durable Object alarm before lease expiry for active runners", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ dispatched: true, runner_id: "gha-g2" }), { status: 200 })
    );
    const base = Date.now();
    const { registry, sql } = makeRegistry(
      { HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" },
      { "gha-g1": { has_activity: true, last_activity_at: base - 30_000, active_requests: 0 } }
    );
    await action(registry, {
      action: "register",
      runner_id: "gha-g1",
      os: "linux",
      arch: "amd64",
      tags: ["provider:github", "agent"],
      duration_seconds: 3600
    });
    // Advance lease window so runner was connected 55 minutes ago and expires in 2 minutes.
    const row = sql.runners.get("gha-g1");
    row.connected_at = base - 58 * 60 * 1000;
    row.expires_at = base + 120_000;

    await registry.alarm();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const runner = (await (await action(registry, { action: "getRunner", runner_id: "gha-g1" })).json() as any).result;
    expect(runner).toMatchObject({ handover_state: "spawning", successor_id: "gha-g2" });
  });

  it("skips alarm handover when handover_after=-1 or duration_seconds <= 300", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { registry, alarms } = makeRegistry({ HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" });

    await action(registry, {
      action: "register",
      runner_id: "short-300",
      os: "linux",
      arch: "amd64",
      tags: ["provider:github", "agent"],
      duration_seconds: 300
    });
    await action(registry, {
      action: "register",
      runner_id: "disabled-ho",
      os: "linux",
      arch: "amd64",
      tags: ["provider:github", "agent"],
      duration_seconds: 3600,
      handover_after: -1
    });

    expect(alarms).toHaveLength(0);
    await registry.alarm();
    expect(fetchSpy).not.toHaveBeenCalled();

    const shortRunner = (await (await action(registry, { action: "getRunner", runner_id: "short-300" })).json() as any).result;
    const disabledRunner = (await (await action(registry, { action: "getRunner", runner_id: "disabled-ho" })).json() as any).result;
    expect(shortRunner.handover_state).toBe("none");
    expect(disabledRunner.handover_state).toBe("none");
    expect(disabledRunner.handover_after).toBe(-1);
  });

  it("skips alarm handover and marks skipped_idle when runner has no recent activity", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const base = Date.now();
    const { registry, sql } = makeRegistry(
      { HANDOVER_WEBHOOK_URL: "https://proxy.example.com/internal/hub/handover" },
      {
        "never-used": { has_activity: false, last_activity_at: null, active_requests: 0 },
        "idle-long": { has_activity: true, last_activity_at: base - 25 * 60 * 1000, active_requests: 0 }
      }
    );

    for (const id of ["never-used", "idle-long"]) {
      await action(registry, {
        action: "register",
        runner_id: id,
        os: "linux",
        arch: "amd64",
        tags: ["provider:github", "agent"],
        duration_seconds: 3600
      });
      const row = sql.runners.get(id);
      row.connected_at = base - 58 * 60 * 1000;
      row.expires_at = base + 120_000;
    }

    await registry.alarm();
    expect(fetchSpy).not.toHaveBeenCalled();

    const r1 = (await (await action(registry, { action: "getRunner", runner_id: "never-used" })).json() as any).result;
    const r2 = (await (await action(registry, { action: "getRunner", runner_id: "idle-long" })).json() as any).result;
    expect(r1.handover_state).toBe("skipped_idle");
    expect(r2.handover_state).toBe("skipped_idle");
  });

  it("routes handover internally via Cloudflare Service Binding MCP_PROXY using MCP_TOKEN with zero extra config", async () => {
    const proxyCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxyFetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        proxyCalls.push({ url: String(input), init });
        return Response.json({ dispatched: true, runner_id: "gha-g2" }, { status: 200 });
      }
    } as unknown as Fetcher;

    const { registry } = makeRegistry({ MCP_PROXY: proxyFetcher });
    await action(registry, {
      action: "register",
      runner_id: "gha-g1",
      os: "linux",
      arch: "amd64",
      repo: "o258p0515/localmcpcoder-go",
      tags: ["provider:github", "account:personal", "pair:p1", "agent"],
      duration_seconds: 3600
    });

    const res = await action(registry, { action: "requestHandover", runner_id: "gha-g1", reason: "quota_expiring" });
    const body = (await res.json() as any).result;
    expect(body).toMatchObject({
      accepted: true,
      handover_state: "spawning",
      transport: "service_binding",
      successor_id: "gha-g2"
    });
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]!.url).toBe("https://github-mcp-proxy/internal/hub/handover");
    expect((proxyCalls[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer test-mcp-token-0123456789abcdef");
    const sent = JSON.parse(String(proxyCalls[0]!.init?.body));
    expect(sent).toMatchObject({
      predecessor_id: "gha-g1",
      provider: "github",
      account: "personal",
      generation: 2
    });
    expect(sent.tags).toContain("pair:p1");
  });
});

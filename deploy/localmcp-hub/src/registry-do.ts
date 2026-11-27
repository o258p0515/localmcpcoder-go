import type { Env, HandoverState, RunnerInfo } from "./types";

const PERSISTENT_PROVIDERS = new Set(["instabox", "upstashbox"]);
const DEFAULT_MAX_GENERATIONS = 0; // 0 = unlimited generations for always-on handover
const HANDOVER_LEAD_MS = 300_000;
const VALID_HANDOVER_STATES = new Set<HandoverState>(["none", "requested", "spawning", "cutover_done", "failed", "skipped_idle"]);

function tagValue(tags: string[], prefix: string): string {
  const match = tags.find((tag) => tag.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function parseGeneration(raw: unknown, tags: string[]): number {
  const explicit = Number(raw);
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;
  const fromTag = Number(tagValue(tags, "gen:"));
  if (Number.isInteger(fromTag) && fromTag >= 1) return fromTag;
  return 1;
}

function inheritedTags(tags: string[]): string[] {
  return tags.filter((tag) => !tag.startsWith("run:") && !tag.startsWith("gen:"));
}

export class RegistryDO {
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS runners (runner_id TEXT PRIMARY KEY, os TEXT NOT NULL, arch TEXT NOT NULL, repo TEXT DEFAULT '', tags_json TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'online', connected_at INTEGER NOT NULL, provider TEXT DEFAULT '', account TEXT DEFAULT '', expires_at INTEGER, handover_state TEXT DEFAULT 'none', predecessor_id TEXT DEFAULT '', successor_id TEXT DEFAULT '', generation INTEGER DEFAULT 1, duration_seconds INTEGER DEFAULT 0, handover_after INTEGER DEFAULT 0, idle_timeout INTEGER DEFAULT 0)");
    for (const column of [
      "provider TEXT DEFAULT ''",
      "account TEXT DEFAULT ''",
      "expires_at INTEGER",
      "handover_state TEXT DEFAULT 'none'",
      "predecessor_id TEXT DEFAULT ''",
      "successor_id TEXT DEFAULT ''",
      "generation INTEGER DEFAULT 1",
      "duration_seconds INTEGER DEFAULT 0",
      "handover_after INTEGER DEFAULT 0",
      "idle_timeout INTEGER DEFAULT 0"
    ]) {
      try {
        this.state.storage.sql.exec(`ALTER TABLE runners ADD COLUMN ${column}`);
      } catch {
        // Column already exists on migrated SQLite storage.
      }
    }
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS session_targets (session_key TEXT PRIMARY KEY, runner_id TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    this.state.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runners_status ON runners(status)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS oauth_grants (jti TEXT PRIMARY KEY, grant_type TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, token_endpoint_auth_method TEXT NOT NULL, client_secret_hash TEXT, redirect_uris_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await request.json() as { action?: string; [key: string]: unknown };
    try {
      let result: unknown;
      switch (body.action) {
        case "register": result = await this.register(body as any); break;
        case "unregister": result = this.unregister(String(body.runner_id ?? "")); break;
        case "setStatus": result = this.setStatus(String(body.runner_id ?? ""), String(body.status ?? "")); break;
        case "requestHandover": result = await this.requestHandover(body as any); break;
        case "completeHandover": result = await this.completeHandover(String(body.predecessor_id ?? ""), String(body.successor_id ?? "")); break;
        case "listRunners": result = this.listRunners(); break;
        case "resolveContext": result = this.resolveContext(String(body.session_key ?? "")); break;
        case "getRunner": result = this.getRunner(String(body.runner_id ?? "")); break;
        case "getSessionRunner": result = this.getSessionRunner(String(body.session_key ?? "")); break;
        case "setSessionRunner": result = this.setSessionRunner(String(body.session_key ?? ""), String(body.runner_id ?? "")); break;
        case "storeOAuthGrant": result = this.storeOAuthGrant(String(body.jti ?? ""), String(body.grant_type ?? ""), Number(body.expires_at)); break;
        case "consumeOAuthGrant": result = this.consumeOAuthGrant(String(body.jti ?? ""), String(body.grant_type ?? "")); break;
        case "registerOAuthClient": result = this.registerOAuthClient(body as any); break;
        case "getOAuthClient": result = this.getOAuthClient(String(body.client_id ?? "")); break;
        default: return Response.json({ error: "unknown registry action" }, { status: 400 });
      }
      return Response.json({ result });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const candidates = this.listRunners().filter((runner) =>
      this.isEligibleForLeaseAlarm(runner) &&
      (runner.expires_at as number) - HANDOVER_LEAD_MS <= now
    );
    for (const runner of candidates) {
      const idleTimeoutMs = (runner.idle_timeout ?? 0) > 0 ? (runner.idle_timeout as number) * 1000 : 0;
      if (idleTimeoutMs > 0) {
        const activity = await this.getRunnerActivity(runner.runner_id);
        if (activity && activity.active_requests === 0) {
          const idleMs = typeof activity.last_activity_at === "number" && activity.last_activity_at > 0
            ? Math.max(0, now - activity.last_activity_at)
            : Math.max(0, now - runner.connected_at);
          if (idleMs >= idleTimeoutMs) {
            this.state.storage.sql.exec("UPDATE runners SET handover_state='skipped_idle' WHERE runner_id=?", runner.runner_id);
            continue;
          }
        }
      }
      await this.requestHandover({
        runner_id: runner.runner_id,
        reason: "lease_alarm",
        remaining_seconds: Math.max(0, Math.floor(((runner.expires_at ?? now) - now) / 1000)),
        generation: runner.generation ?? 1
      });
    }
    await this.scheduleNextAlarm();
  }

  private async register(input: {
    runner_id: string;
    os: string;
    arch: string;
    repo?: string;
    tags?: string[];
    provider?: string;
    account?: string;
    duration_seconds?: number;
    expires_at?: number | null;
    predecessor_id?: string;
    generation?: number;
    handover_after?: number;
    idle_timeout?: number;
  }): Promise<RunnerInfo & { cutover?: { predecessor_id: string; migrated_sessions: number } }> {
    if (!input.runner_id || !input.os || !input.arch) throw new Error("runner_id, os and arch are required");
    const tags = Array.isArray(input.tags) ? input.tags.filter(Boolean) : [];
    const now = Date.now();
    const provider = String(input.provider ?? "").trim().toLowerCase() || tagValue(tags, "provider:").toLowerCase();
    const account = String(input.account ?? "").trim() || tagValue(tags, "account:");
    const predecessorId = String(input.predecessor_id ?? "").trim();
    const generation = parseGeneration(input.generation, tags);
    const durationSecondsRaw = Number(input.duration_seconds ?? 0);
    const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0 ? Math.floor(durationSecondsRaw) : 0;
    const handoverAfter = Number.isInteger(Number(input.handover_after)) ? Number(input.handover_after) : 0;
    const idleTimeoutRaw = Number(input.idle_timeout ?? 0);
    const idleTimeout = Number.isFinite(idleTimeoutRaw) && idleTimeoutRaw > 0 ? Math.floor(idleTimeoutRaw) : 0;
    const expiresAt = typeof input.expires_at === "number" && Number.isFinite(input.expires_at) && input.expires_at > 0
      ? Math.floor(input.expires_at)
      : (Number.isFinite(durationSeconds) && durationSeconds > 0 ? now + Math.floor(durationSeconds) * 1000 : null);

    this.state.storage.sql.exec(
      "INSERT INTO runners(runner_id,os,arch,repo,tags_json,status,connected_at,provider,account,expires_at,handover_state,predecessor_id,successor_id,generation,duration_seconds,handover_after,idle_timeout) VALUES(?,?,?,?,?,'online',?,?,?,?,'none',?,'',?,?,?,?) ON CONFLICT(runner_id) DO UPDATE SET os=excluded.os,arch=excluded.arch,repo=excluded.repo,tags_json=excluded.tags_json,status='online',connected_at=excluded.connected_at,provider=excluded.provider,account=excluded.account,expires_at=excluded.expires_at,handover_state='none',predecessor_id=excluded.predecessor_id,successor_id='',generation=excluded.generation,duration_seconds=excluded.duration_seconds,handover_after=excluded.handover_after,idle_timeout=excluded.idle_timeout",
      input.runner_id,
      input.os,
      input.arch,
      input.repo ?? "",
      JSON.stringify(tags),
      now,
      provider,
      account,
      expiresAt,
      predecessorId,
      generation,
      durationSeconds,
      handoverAfter,
      idleTimeout
    );

    let cutover: { predecessor_id: string; migrated_sessions: number } | undefined;
    if (predecessorId && predecessorId !== input.runner_id) {
      const result = await this.completeHandover(predecessorId, input.runner_id);
      if (result.completed) {
        cutover = { predecessor_id: predecessorId, migrated_sessions: result.migrated_sessions };
      }
    }
    await this.scheduleNextAlarm();
    const runner = this.getRunner(input.runner_id)!;
    return cutover ? { ...runner, cutover } : runner;
  }

  private async completeHandover(predecessorId: string, successorId: string): Promise<{ completed: boolean; predecessor_id: string; successor_id: string; migrated_sessions: number }> {
    if (!predecessorId || !successorId || predecessorId === successorId) {
      return { completed: false, predecessor_id: predecessorId, successor_id: successorId, migrated_sessions: 0 };
    }
    const predecessor = this.getRunner(predecessorId);
    const successor = this.getRunner(successorId);
    if (!predecessor || !successor || successor.status !== "online") {
      return { completed: false, predecessor_id: predecessorId, successor_id: successorId, migrated_sessions: 0 };
    }
    const now = Date.now();
    const sessionCursor = this.state.storage.sql.exec(
      "UPDATE session_targets SET runner_id=?,updated_at=? WHERE runner_id=?",
      successorId,
      now,
      predecessorId
    );
    this.state.storage.sql.exec(
      "UPDATE runners SET status='draining',handover_state='cutover_done',successor_id=? WHERE runner_id=?",
      successorId,
      predecessorId
    );
    await this.notifyRunnerShutdown(predecessorId, "handover_complete", successorId);
    return {
      completed: true,
      predecessor_id: predecessorId,
      successor_id: successorId,
      migrated_sessions: sessionCursor.rowsWritten ?? 0
    };
  }

  private async requestHandover(input: {
    runner_id?: string;
    reason?: string;
    remaining_seconds?: number;
    active_requests?: number;
    idle_seconds?: number;
    generation?: number;
    tags?: string[];
    os?: string;
    arch?: string;
    repo?: string;
  }): Promise<Record<string, unknown>> {
    const runnerId = String(input.runner_id ?? "").trim();
    if (!runnerId) throw new Error("runner_id is required");
    const runner = this.getRunner(runnerId);
    if (!runner) return { accepted: false, reason: "runner_not_found", runner_id: runnerId };
    if (runner.status !== "online") {
      return { accepted: false, reason: "runner_not_online", runner_id: runnerId, status: runner.status };
    }
    if (runner.handover_state === "spawning" || runner.handover_state === "cutover_done") {
      return { accepted: false, reason: "already_in_progress", runner_id: runnerId, handover_state: runner.handover_state, successor_id: runner.successor_id ?? null };
    }

    const provider = (runner.provider || tagValue(runner.tags, "provider:")).toLowerCase();
    if (PERSISTENT_PROVIDERS.has(provider)) {
      return { accepted: false, reason: "persistent_provider_uses_resume", runner_id: runnerId, provider };
    }
    if ((runner.handover_after ?? 0) < 0 && String(input.reason ?? "") === "lease_alarm") {
      return { accepted: false, reason: "handover_disabled", runner_id: runnerId };
    }

    const rawMaxGen = this.env.HANDOVER_MAX_GENERATIONS;
    const parsedMaxGen = rawMaxGen !== undefined && String(rawMaxGen).trim() !== "" ? Number(rawMaxGen) : DEFAULT_MAX_GENERATIONS;
    const maxGenerations = Number.isFinite(parsedMaxGen) && parsedMaxGen > 0 ? Math.floor(parsedMaxGen) : 0;
    const generation = Math.max(runner.generation ?? 1, Number(input.generation ?? 0) || 1);
    if (maxGenerations > 0 && generation >= maxGenerations) {
      this.state.storage.sql.exec("UPDATE runners SET handover_state='failed' WHERE runner_id=?", runnerId);
      return { accepted: false, reason: "max_generations_reached", runner_id: runnerId, generation, max_generations: maxGenerations };
    }

    const webhookUrl = String(this.env.HANDOVER_WEBHOOK_URL ?? "").trim();
    const proxyService = this.env.MCP_PROXY;
    if (!webhookUrl && !proxyService) {
      this.state.storage.sql.exec("UPDATE runners SET handover_state='requested' WHERE runner_id=?", runnerId);
      return { accepted: true, runner_id: runnerId, handover_state: "requested", webhook_configured: false, next_generation: generation + 1 };
    }

    this.state.storage.sql.exec("UPDATE runners SET handover_state='spawning' WHERE runner_id=?", runnerId);
    const webhookToken = String(this.env.HANDOVER_WEBHOOK_TOKEN || this.env.MCP_TOKEN || "").trim();
    const nextGeneration = generation + 1;
    const payload = {
      predecessor_id: runner.runner_id,
      provider: provider || "github",
      account: runner.account || tagValue(runner.tags, "account:") || "personal",
      os: runner.os,
      arch: runner.arch,
      repo: runner.repo,
      tags: inheritedTags(runner.tags),
      generation: nextGeneration,
      reason: String(input.reason ?? "quota_expiring"),
      remaining_seconds: Number(input.remaining_seconds ?? 0),
      active_requests: Number(input.active_requests ?? 0),
      idle_seconds: Number(input.idle_seconds ?? 0),
      ...((runner.duration_seconds ?? 0) > 0 ? { duration_seconds: runner.duration_seconds } : {}),
      ...((runner.handover_after ?? 0) > 0 ? { handover_after: runner.handover_after } : {}),
      ...((runner.idle_timeout ?? 0) > 0 ? { idle_timeout: runner.idle_timeout } : {})
    };

    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(webhookToken ? { Authorization: "Bearer " + webhookToken } : {})
        },
        body: JSON.stringify(payload)
      };
      const transport = webhookUrl ? "webhook" : "service_binding";
      const response = webhookUrl
        ? await fetch(webhookUrl, requestInit)
        : await proxyService!.fetch("https://github-mcp-proxy/internal/hub/handover", requestInit);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        this.state.storage.sql.exec("UPDATE runners SET handover_state='failed' WHERE runner_id=?", runnerId);
        return {
          accepted: false,
          reason: "spawn_failed",
          runner_id: runnerId,
          transport,
          status: response.status,
          error: String(body.error ?? `handover ${transport} returned HTTP ${response.status}`)
        };
      }
      if (body.skipped === true) {
        this.state.storage.sql.exec("UPDATE runners SET handover_state='none' WHERE runner_id=?", runnerId);
        return { accepted: false, runner_id: runnerId, transport, ...body };
      }
      const successorId = typeof body.runner_id === "string" ? body.runner_id : "";
      if (successorId) {
        this.state.storage.sql.exec("UPDATE runners SET handover_state='spawning',successor_id=? WHERE runner_id=?", successorId, runnerId);
      }
      return {
        accepted: true,
        runner_id: runnerId,
        handover_state: "spawning",
        transport,
        next_generation: nextGeneration,
        successor_id: successorId || null,
        spawn: body
      };
    } catch (error) {
      // Never send shutdown to the predecessor when spawning a successor fails.
      this.state.storage.sql.exec("UPDATE runners SET handover_state='failed' WHERE runner_id=?", runnerId);
      return {
        accepted: false,
        reason: "spawn_failed",
        runner_id: runnerId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private isEligibleForLeaseAlarm(runner: RunnerInfo): boolean {
    if (runner.status !== "online") return false;
    if ((runner.handover_state ?? "none") !== "none") return false;
    if ((runner.handover_after ?? 0) < 0) return false;
    if (typeof runner.expires_at !== "number" || runner.expires_at <= 0) return false;
    // Short-lived runners (<= 5 min total lease) must not trigger immediate alarm
    // handover right after connecting; explicit --handover-after timers still work.
    if (runner.expires_at - runner.connected_at <= HANDOVER_LEAD_MS) return false;
    const provider = (runner.provider || tagValue(runner.tags, "provider:")).toLowerCase();
    if (PERSISTENT_PROVIDERS.has(provider)) return false;
    return true;
  }

  private async getRunnerActivity(runnerId: string): Promise<{ has_activity: boolean; last_activity_at: number | null; active_requests: number } | null> {
    if (!this.env?.RUNNER_DO) return null;
    try {
      const stub = this.env.RUNNER_DO.get(this.env.RUNNER_DO.idFromName(runnerId));
      const response = await stub.fetch("https://runner/activity", { method: "GET" });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null) as { result?: Record<string, unknown> } | null;
      const result = body?.result;
      if (!result || typeof result.active_requests !== "number" || typeof result.has_activity !== "boolean") {
        return null;
      }
      return {
        has_activity: result.has_activity,
        last_activity_at: typeof result.last_activity_at === "number" ? result.last_activity_at : null,
        active_requests: result.active_requests
      };
    } catch {
      return null;
    }
  }

  private async notifyRunnerShutdown(runnerId: string, reason: string, successorId: string): Promise<void> {
    if (!this.env?.RUNNER_DO) return;
    try {
      const stub = this.env.RUNNER_DO.get(this.env.RUNNER_DO.idFromName(runnerId));
      await stub.fetch("https://runner/shutdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, successor_id: successorId })
      });
    } catch {
      // Predecessor may already be disconnecting; do not abort registration cutover.
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const setAlarm = (this.state.storage as DurableObjectStorage & { setAlarm?: (t: number) => Promise<void> }).setAlarm;
    if (typeof setAlarm !== "function") return;
    const now = Date.now();
    let earliest: number | null = null;
    for (const runner of this.listRunners()) {
      if (!this.isEligibleForLeaseAlarm(runner)) continue;
      const triggerAt = Math.max(now + 1_000, (runner.expires_at as number) - HANDOVER_LEAD_MS);
      if (earliest === null || triggerAt < earliest) earliest = triggerAt;
    }
    if (earliest !== null) {
      await setAlarm.call(this.state.storage, earliest);
    }
  }

  private unregister(id: string): { removed: boolean } {
    const cursor = this.state.storage.sql.exec("DELETE FROM runners WHERE runner_id=?", id);
    this.state.storage.sql.exec("DELETE FROM session_targets WHERE runner_id=?", id);
    return { removed: cursor.rowsWritten > 0 };
  }
  private setStatus(id: string, status: string): RunnerInfo | null {
    if (status !== "online" && status !== "draining") throw new Error("invalid runner status");
    this.state.storage.sql.exec("UPDATE runners SET status=? WHERE runner_id=?", status, id);
    return this.getRunner(id);
  }
  private listRunners(): RunnerInfo[] {
    return this.state.storage.sql.exec<any>("SELECT * FROM runners ORDER BY connected_at DESC").toArray().map((row) => this.rowToRunner(row));
  }
  private resolveContext(key: string): { runners: RunnerInfo[]; selected_runner: string | null } {
    // One RegistryDO request returns both values needed for routing. Keep the
    // two SQL reads inside the same DO invocation to halve inter-DO requests.
    return { runners: this.listRunners(), selected_runner: this.getSessionRunner(key) };
  }
  private getRunner(id: string): RunnerInfo | null {
    const row = this.state.storage.sql.exec<any>("SELECT * FROM runners WHERE runner_id=?", id).toArray()[0];
    return row ? this.rowToRunner(row) : null;
  }
  private getSessionRunner(key: string): string | null {
    const row = this.state.storage.sql.exec<any>("SELECT runner_id FROM session_targets WHERE session_key=?", key).toArray()[0];
    if (row?.runner_id) return row.runner_id;
    if (key !== "default") {
      const fallback = this.state.storage.sql.exec<any>("SELECT runner_id FROM session_targets WHERE session_key=?", "default").toArray()[0];
      return fallback?.runner_id ?? null;
    }
    return null;
  }
  private setSessionRunner(key: string, id: string): { session_key: string; runner_id: string } {
    const runner = this.getRunner(id);
    if (!runner || runner.status !== "online") throw new Error("runner is not online");
    this.state.storage.sql.exec("INSERT INTO session_targets(session_key,runner_id,updated_at) VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET runner_id=excluded.runner_id,updated_at=excluded.updated_at", key, id, Date.now());
    return { session_key: key, runner_id: id };
  }
  private storeOAuthGrant(jti: string, grantType: string, expiresAt: number): { stored: boolean } {
    if (!jti || !["code", "refresh"].includes(grantType) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("invalid OAuth grant");
    }
    this.state.storage.sql.exec("DELETE FROM oauth_grants WHERE expires_at <= ?", Date.now());
    this.state.storage.sql.exec("INSERT INTO oauth_grants(jti,grant_type,expires_at) VALUES(?,?,?)", jti, grantType, expiresAt);
    return { stored: true };
  }
  private consumeOAuthGrant(jti: string, grantType: string): { consumed: boolean } {
    if (!jti || !["code", "refresh"].includes(grantType)) return { consumed: false };
    const row = this.state.storage.sql.exec<any>("SELECT jti FROM oauth_grants WHERE jti=? AND grant_type=? AND expires_at>?", jti, grantType, Date.now()).toArray()[0];
    if (!row) return { consumed: false };
    this.state.storage.sql.exec("DELETE FROM oauth_grants WHERE jti=? AND grant_type=?", jti, grantType);
    return { consumed: true };
  }
  private registerOAuthClient(input: {
    client_id: string;
    client_name: string;
    token_endpoint_auth_method: string;
    client_secret_hash?: string | null;
    redirect_uris: string[];
    expires_at: number;
  }): { registered: boolean } {
    if (!input.client_id || !Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || !Number.isSafeInteger(input.expires_at) || input.expires_at <= Date.now()) {
      throw new Error("invalid OAuth client registration");
    }
    this.state.storage.sql.exec("DELETE FROM oauth_clients WHERE expires_at <= ?", Date.now());
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO oauth_clients(client_id,client_name,token_endpoint_auth_method,client_secret_hash,redirect_uris_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      input.client_id,
      String(input.client_name || "Dynamic MCP client"),
      String(input.token_endpoint_auth_method || "none"),
      input.client_secret_hash ?? null,
      JSON.stringify(input.redirect_uris),
      Date.now(),
      input.expires_at
    );
    return { registered: true };
  }
  private getOAuthClient(clientId: string): Record<string, unknown> | null {
    if (!clientId) return null;
    const row = this.state.storage.sql.exec<any>(
      "SELECT client_id,client_name,token_endpoint_auth_method,client_secret_hash,redirect_uris_json FROM oauth_clients WHERE client_id=? AND expires_at>?",
      clientId,
      Date.now()
    ).toArray()[0];
    if (!row) return null;
    let redirectUris: string[] = [];
    try { redirectUris = JSON.parse(String(row.redirect_uris_json ?? "[]")); } catch { redirectUris = []; }
    return {
      client_id: String(row.client_id),
      client_name: String(row.client_name),
      token_endpoint_auth_method: String(row.token_endpoint_auth_method),
      ...(row.client_secret_hash ? { client_secret_hash: String(row.client_secret_hash) } : {}),
      redirect_uris: redirectUris
    };
  }
  private rowToRunner(row: any): RunnerInfo {
    let tags: string[] = [];
    try { tags = JSON.parse(String(row.tags_json ?? "[]")); } catch { /* tolerate old rows */ }
    const rawState = String(row.handover_state ?? "none") as HandoverState;
    const handoverState: HandoverState = VALID_HANDOVER_STATES.has(rawState) ? rawState : "none";
    const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at);
    return {
      runner_id: String(row.runner_id),
      os: String(row.os),
      arch: String(row.arch),
      repo: String(row.repo ?? ""),
      tags,
      status: row.status === "draining" ? "draining" : "online",
      connected_at: Number(row.connected_at),
      provider: String(row.provider ?? ""),
      account: String(row.account ?? ""),
      expires_at: Number.isFinite(expiresAt) ? expiresAt : null,
      handover_state: handoverState,
      predecessor_id: row.predecessor_id ? String(row.predecessor_id) : null,
      successor_id: row.successor_id ? String(row.successor_id) : null,
      generation: Number(row.generation ?? 1) || 1,
      duration_seconds: Number(row.duration_seconds ?? 0) || 0,
      handover_after: Number.isInteger(Number(row.handover_after)) ? Number(row.handover_after) : 0,
      idle_timeout: Number(row.idle_timeout ?? 0) || 0
    };
  }
}

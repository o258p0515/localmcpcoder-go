import type { Env, RunnerInfo } from "./types";

export class RegistryDO {
  private state: DurableObjectState;
  private env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS runners (runner_id TEXT PRIMARY KEY, os TEXT NOT NULL, arch TEXT NOT NULL, repo TEXT DEFAULT '', tags_json TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'online', connected_at INTEGER NOT NULL)");
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
        case "register": result = this.register(body as any); break;
        case "unregister": result = this.unregister(String(body.runner_id ?? "")); break;
        case "setStatus": result = this.setStatus(String(body.runner_id ?? ""), String(body.status ?? "")); break;
        case "listRunners": result = this.listRunners(); break;
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
  private register(input: { runner_id: string; os: string; arch: string; repo?: string; tags?: string[] }): RunnerInfo {
    if (!input.runner_id || !input.os || !input.arch) throw new Error("runner_id, os and arch are required");
    this.state.storage.sql.exec(
      "INSERT INTO runners(runner_id,os,arch,repo,tags_json,status,connected_at) VALUES(?,?,?,?,?,'online',?) ON CONFLICT(runner_id) DO UPDATE SET os=excluded.os,arch=excluded.arch,repo=excluded.repo,tags_json=excluded.tags_json,status='online',connected_at=excluded.connected_at",
      input.runner_id, input.os, input.arch, input.repo ?? "", JSON.stringify(input.tags ?? []), Date.now()
    );
    return this.getRunner(input.runner_id)!;
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
  private getRunner(id: string): RunnerInfo | null {
    const row = this.state.storage.sql.exec<any>("SELECT * FROM runners WHERE runner_id=?", id).toArray()[0];
    return row ? this.rowToRunner(row) : null;
  }
  private getSessionRunner(key: string): string | null {
    const row = this.state.storage.sql.exec<any>("SELECT runner_id FROM session_targets WHERE session_key=?", key).toArray()[0];
    return row?.runner_id ?? null;
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
    return { runner_id: String(row.runner_id), os: String(row.os), arch: String(row.arch), repo: String(row.repo ?? ""), tags,
      status: row.status === "draining" ? "draining" : "online", connected_at: Number(row.connected_at) };
  }
}

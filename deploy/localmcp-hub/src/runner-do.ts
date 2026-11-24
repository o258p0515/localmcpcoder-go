import type { Env } from "./types";

type Pending = {
  resolve: (value: any) => void;
  jobCreated: boolean;
  socket: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
};

const DISCONNECTED_MESSAGE = "runner websocket disconnected before the request completed";

export class RunnerDO {
  private ctx: DurableObjectState;
  private env: Env;
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    const hibernation = this.ctx as DurableObjectState & {
      setWebSocketAutoResponse?: (pair: unknown) => void;
    };
    const Pair = (globalThis as any).WebSocketRequestResponsePair;
    if (Pair && hibernation.setWebSocketAutoResponse) {
      hibernation.setWebSocketAutoResponse(new Pair("ping", "pong"));
    }
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS async_jobs (job_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)"
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_async_jobs_created ON async_jobs(created_at)"
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/connect")) return this.connect(request);
    if (url.pathname.endsWith("/dispatch")) return this.dispatch(request);
    if (url.pathname.endsWith("/job")) return this.getJob(url.searchParams.get("job_id") ?? "");
    return new Response("not found", { status: 404 });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const url = new URL(request.url);
    const runnerId = url.searchParams.get("id") ?? "";
    if (!runnerId) return new Response("runner id required", { status: 400 });
    const meta = {
      runner_id: runnerId,
      os: url.searchParams.get("os") ?? "unknown",
      arch: url.searchParams.get("arch") ?? "unknown",
      repo: url.searchParams.get("repo") ?? "",
      tags: (url.searchParams.get("tags") ?? "").split(",").filter(Boolean),
      connected_at: Date.now()
    };
    // A reconnect supersedes every still-open socket for this runner ID. Close
    // the old transport before accepting the new one so dispatch cannot race
    // onto a stale WebSocket.
    for (const existing of this.ctx.getWebSockets()) {
      const oldMeta = (existing as any).deserializeAttachment?.();
      if (oldMeta?.runner_id === runnerId && existing.readyState < 2) {
        try { existing.close(1012, "runner reconnected"); } catch { /* already closing */ }
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    (server as any).serializeAttachment(meta);
    this.ctx.acceptWebSocket(server, [runnerId]);
    await this.ctx.storage.put("runner_id", runnerId);
    await this.registry({ action: "register", ...meta });
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  private async dispatch(request: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).sort((a, b) => Number((b as any).deserializeAttachment?.()?.connected_at ?? 0) - Number((a as any).deserializeAttachment?.()?.connected_at ?? 0));
    if (sockets.length === 0) {
      const id = await this.ctx.storage.get<string>("runner_id");
      if (id) await this.registry({ action: "unregister", runner_id: id });
      return Response.json(
        { error: "runner websocket is offline; call list_runners and select an online runner" },
        { status: 503 }
      );
    }

    const body = await request.json() as { payload: any; async?: boolean; tool_name?: string };
    const reqId = crypto.randomUUID();
    const toolName = body.tool_name ?? body.payload?.method ?? "unknown";
    const wantsAsync = body.async === true;
    const socket = sockets[0];

    const pendingResult = new Promise<any>((resolve) => {
      const entry: Pending = { resolve, jobCreated: wantsAsync, socket };
      this.pending.set(reqId, entry);
      if (wantsAsync) {
        this.createJob(reqId, toolName);
      } else {
        entry.timer = setTimeout(() => {
          const current = this.pending.get(reqId);
          if (!current || current.jobCreated) return;
          current.jobCreated = true;
          current.timer = undefined;
          this.createJob(reqId, toolName);
          current.resolve({
            status: "running",
            job_id: reqId,
            runner_id: idFromAttachment(socket),
            hint: "Call get_job_result to retrieve the result."
          });
        }, 45_000);
      }
    });

    try {
      socket.send(JSON.stringify({ type: "rpc_request", req_id: reqId, payload: body.payload }));
    } catch (error) {
      const entry = this.pending.get(reqId);
      if (entry?.timer) clearTimeout(entry.timer);
      this.pending.delete(reqId);
      if (wantsAsync) {
        this.ctx.storage.sql.exec(
          "UPDATE async_jobs SET status='failed',result_json=?,finished_at=? WHERE job_id=?",
          JSON.stringify({ error: String(error) }),
          Date.now(),
          reqId
        );
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 502 }
      );
    }

    if (wantsAsync) {
      return Response.json({
        result: {
          status: "running",
          job_id: reqId,
          runner_id: idFromAttachment(socket),
          hint: "Call get_job_result to retrieve the result."
        }
      });
    }

    const result = await pendingResult;
    if (result?.status === "running") return Response.json({ result });
    if (result?.status === "dispatch_error") {
      return Response.json({ error: result.message }, { status: 503 });
    }
    this.pending.delete(reqId);
    return Response.json({ result });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let frame: any;
    try { frame = JSON.parse(message); } catch { return; }
    const meta = (ws as any).deserializeAttachment?.();
    const runnerId = String(meta?.runner_id ?? await this.ctx.storage.get<string>("runner_id") ?? "");

    if (frame.type === "status_update" && frame.status === "draining") {
      if (runnerId) await this.registry({ action: "setStatus", runner_id: runnerId, status: "draining" });
      return;
    }
    if (frame.type !== "rpc_response" || !frame.req_id) return;

    const reqId = String(frame.req_id);
    const payload = frame.payload ?? {};
    const entry = this.pending.get(reqId);
    // A normal synchronous response cannot have an async_jobs row. Avoid a
    // SQLite read on this hot path; retain the lookup for async/orphaned jobs.
    const row = entry && !entry.jobCreated ? undefined : this.ctx.storage.sql.exec<any>(
      "SELECT job_id FROM async_jobs WHERE job_id=?",
      reqId
    ).toArray()[0];
    if (row) {
      this.ctx.storage.sql.exec(
        "UPDATE async_jobs SET status=?,result_json=?,finished_at=? WHERE job_id=?",
        (!!payload.error || payload.result?.isError === true) ? "failed" : "completed",
        JSON.stringify(payload),
        Date.now(),
        reqId
      );
    }

    if (!entry || entry.socket !== ws) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.jobCreated) entry.resolve(payload);
    this.pending.delete(reqId);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = (ws as any).deserializeAttachment?.();
    const id = String(attachment?.runner_id ?? await this.ctx.storage.get<string>("runner_id") ?? "");
    const errorPayload = {
      jsonrpc: "2.0",
      error: { code: -32000, message: DISCONNECTED_MESSAGE }
    };

    for (const [reqId, entry] of this.pending) {
      if (entry.socket !== ws) continue;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.jobCreated) {
        this.ctx.storage.sql.exec(
          "UPDATE async_jobs SET status='failed',result_json=?,finished_at=? WHERE job_id=?",
          JSON.stringify(errorPayload),
          Date.now(),
          reqId
        );
      } else {
        entry.resolve({ status: "dispatch_error", message: DISCONNECTED_MESSAGE });
      }
      this.pending.delete(reqId);
    }

    const remaining = this.ctx.getWebSockets().filter((socket) => socket.readyState === 1);
    if (id && remaining.length === 0) {
      await this.registry({ action: "unregister", runner_id: id });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private createJob(id: string, tool: string): void {
    // Retention cleanup is needed only when persisting an async job, never on
    // every ordinary synchronous dispatch.
    this.cleanupJobs();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO async_jobs(job_id,tool_name,status,result_json,created_at,finished_at) VALUES(?,?,'running',NULL,?,NULL)",
      id,
      tool,
      Date.now()
    );
  }

  private cleanupJobs(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM async_jobs WHERE status IN ('completed','failed') AND finished_at < ?",
      Date.now() - 86_400_000
    );
  }

  private async getJob(id: string): Promise<Response> {
    const row = this.ctx.storage.sql.exec<any>(
      "SELECT * FROM async_jobs WHERE job_id=?",
      id
    ).toArray()[0];
    if (!row) return Response.json({ error: "job not found or expired" }, { status: 404 });
    let result: unknown = null;
    try { result = row.result_json ? JSON.parse(row.result_json) : null; }
    catch { result = row.result_json; }
    return Response.json({
      job_id: row.job_id,
      tool_name: row.tool_name,
      status: row.status,
      result,
      created_at: row.created_at,
      finished_at: row.finished_at
    });
  }

  private async registry(payload: unknown): Promise<any> {
    const stub = this.env.REGISTRY_DO.get(this.env.REGISTRY_DO.idFromName("global"));
    const response = await stub.fetch("https://registry/internal", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(data.error ?? "registry request failed");
    return data.result;
  }
}

function idFromAttachment(ws: WebSocket): string {
  return String((ws as any).deserializeAttachment?.()?.runner_id ?? "");
}
  282
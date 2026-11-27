import { describe, expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do";
import type { Env } from "../src/types";

class FakeSQL {
  rows = new Map<string, any>();
  queries: string[] = [];
  exec(query: string, ...args: any[]) {
    this.queries.push(query);
    if (query.startsWith("INSERT OR REPLACE INTO async_jobs")) {
      const [job_id, tool_name, created_at] = args;
      this.rows.set(job_id, { job_id, tool_name, status: "running", result_json: null, created_at, finished_at: null });
      return { rowsWritten: 1, toArray: () => [] };
    }
    if (query.startsWith("SELECT job_id FROM async_jobs")) {
      const row = this.rows.get(args[0]);
      return { rowsWritten: 0, toArray: () => row ? [{ job_id: row.job_id }] : [] };
    }
    if (query.startsWith("SELECT * FROM async_jobs")) {
      const row = this.rows.get(args[0]);
      return { rowsWritten: 0, toArray: () => row ? [{ ...row }] : [] };
    }
    if (query.startsWith("UPDATE async_jobs SET status='failed'")) {
      const row = this.rows.get(args[2]);
      if (row) Object.assign(row, { status: "failed", result_json: args[0], finished_at: args[1] });
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("UPDATE async_jobs SET status=?")) {
      const row = this.rows.get(args[3]);
      if (row) Object.assign(row, { status: args[0], result_json: args[1], finished_at: args[2] });
      return { rowsWritten: row ? 1 : 0, toArray: () => [] };
    }
    if (query.startsWith("DELETE FROM async_jobs")) {
      let deleted = 0;
      for (const [id, row] of this.rows) {
        if ((row.status === "completed" || row.status === "failed") && row.finished_at < args[0]) {
          this.rows.delete(id);
          deleted++;
        }
      }
      return { rowsWritten: deleted, toArray: () => [] };
    }
    return { rowsWritten: 0, toArray: () => [] };
  }
}

function makeRunner() {
  const sql = new FakeSQL();
  const values = new Map<string, unknown>([["runner_id", "runner-1"]]);
  const registryCalls: any[] = [];
  const socket = {
    readyState: 1,
    send: vi.fn(),
    deserializeAttachment: () => ({ runner_id: "runner-1", connected_at: 1 })
  };
  const state = {
    storage: {
      sql,
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value); }
    },
    getWebSockets: () => socket.readyState === 1 ? [socket] : [],
    acceptWebSocket: vi.fn()
  };
  const registryStub = {
    fetch: async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      registryCalls.push(body);
      if (body.action === "requestHandover") {
        return Response.json({ result: { accepted: true, handover_state: "spawning", successor_id: "runner-2" } });
      }
      return Response.json({ result: true });
    }
  };
  const env = {
    REGISTRY_DO: { idFromName: () => "global", get: () => registryStub }
  } as unknown as Env;
  return { runner: new RunnerDO(state as any, env), socket, sql, registryCalls };
}

describe("RunnerDO disconnect and handover handling", () => {
  it("fails a pending synchronous dispatch instead of leaving the MCP request hanging", async () => {
    const { runner, socket } = makeRunner();
    const pending = runner.fetch(new Request("https://runner/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { jsonrpc: "2.0", id: "rpc-1", method: "tools/call" } })
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.send).toHaveBeenCalledOnce();
    socket.readyState = 3;
    await runner.webSocketClose(socket as any);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "runner websocket disconnected before the request completed" });
  });

  it("does not clean up or query SQLite for a normal synchronous response", async () => {
    const { runner, socket, sql } = makeRunner();
    const responsePromise = runner.fetch(new Request("https://runner/dispatch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { jsonrpc: "2.0", id: "rpc-sync", method: "tools/call" }, tool_name: "bash" })
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requestFrame = JSON.parse((socket.send as any).mock.calls[0][0]);
    await runner.webSocketMessage(socket as any, JSON.stringify({
      type: "rpc_response", req_id: requestFrame.req_id,
      payload: { jsonrpc: "2.0", id: "rpc-sync", result: { content: [{ type: "text", text: "ok" }] } }
    }));
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(sql.queries.some((query) => query.startsWith("DELETE FROM async_jobs"))).toBe(false);
    expect(sql.queries.some((query) => query.startsWith("SELECT job_id FROM async_jobs"))).toBe(false);
  });

  it("marks an async job failed when its runner disconnects", async () => {
    const { runner, socket, sql } = makeRunner();
    const response = await runner.fetch(new Request("https://runner/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { jsonrpc: "2.0", id: "rpc-2", method: "tools/call" }, async: true, tool_name: "bash" })
    }));
    const body = await response.json() as any;
    const jobId = body.result.job_id;
    expect(sql.rows.get(jobId).status).toBe("running");
    socket.readyState = 3;
    await runner.webSocketClose(socket as any);
    const jobResponse = await runner.fetch(new Request("https://runner/job?job_id=" + jobId));
    const job = await jobResponse.json() as any;
    expect(job.status).toBe("failed");
    expect(job.result.error.message).toContain("disconnected");
  });

  it("routes overlapping reconnect sockets to the newest and ignores the old socket close", async () => {
    const sql = new FakeSQL();
    const oldSocket = { readyState: 1, send: vi.fn(), deserializeAttachment: () => ({ runner_id: "runner-1", connected_at: 1 }) };
    const newSocket = { readyState: 1, send: vi.fn(), deserializeAttachment: () => ({ runner_id: "runner-1", connected_at: 2 }) };
    const values = new Map<string, unknown>([["runner_id", "runner-1"]]);
    const registryCalls: any[] = [];
    const state = {
      storage: { sql, get: async (k: string) => values.get(k), put: async (k: string, v: unknown) => { values.set(k, v); } },
      getWebSockets: () => [oldSocket, newSocket],
      acceptWebSocket: vi.fn()
    };
    const env = { REGISTRY_DO: { idFromName: () => "global", get: () => ({ fetch: async (_: any, init: any) => {
      registryCalls.push(JSON.parse(String(init.body))); return Response.json({ result: true });
    } }) } } as unknown as Env;
    const runner = new RunnerDO(state as any, env);
    const response = await runner.fetch(new Request("https://runner/dispatch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { jsonrpc: "2.0", id: 1, method: "tools/call" }, async: true })
    }));
    expect(response.status).toBe(200);
    expect(newSocket.send).toHaveBeenCalledOnce();
    expect(oldSocket.send).not.toHaveBeenCalled();
    oldSocket.readyState = 3;
    await runner.webSocketClose(oldSocket as any);
    expect(registryCalls.some((call) => call.action === "unregister")).toBe(false);
  });

  it("forwards handover_request frames to RegistryDO and replies with handover_ack", async () => {
    const { runner, socket, registryCalls } = makeRunner();
    await runner.webSocketMessage(socket as any, JSON.stringify({
      type: "handover_request",
      reason: "quota_expiring",
      remaining_seconds: 300,
      generation: 1
    }));
    expect(registryCalls.some((c) => c.action === "requestHandover" && c.runner_id === "runner-1")).toBe(true);
    const ack = JSON.parse((socket.send as any).mock.calls[0][0]);
    expect(ack).toMatchObject({ type: "handover_ack", accepted: true, handover_state: "spawning", successor_id: "runner-2" });
  });

  it("sends WebSocket shutdown frame while letting in-flight requests finish draining", async () => {
    const { runner, socket, registryCalls } = makeRunner();
    const inflight = runner.fetch(new Request("https://runner/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { jsonrpc: "2.0", id: "rpc-inflight", method: "tools/call" }, tool_name: "bash" })
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reqFrame = JSON.parse((socket.send as any).mock.calls[0][0]);

    const shutdownRes = await runner.fetch(new Request("https://runner/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "handover_complete", successor_id: "runner-2" })
    }));
    expect(shutdownRes.status).toBe(200);
    expect(await shutdownRes.json()).toMatchObject({ result: { runner_id: "runner-1", notified: 1, status: "draining" } });
    expect(registryCalls.some((c) => c.action === "setStatus" && c.status === "draining")).toBe(true);
    const shutdownFrame = JSON.parse((socket.send as any).mock.calls[1][0]);
    expect(shutdownFrame).toEqual({ type: "shutdown", reason: "handover_complete", successor_id: "runner-2" });

    // In-flight request still completes cleanly after shutdown frame was sent.
    await runner.webSocketMessage(socket as any, JSON.stringify({
      type: "rpc_response",
      req_id: reqFrame.req_id,
      payload: { jsonrpc: "2.0", id: "rpc-inflight", result: { content: [{ type: "text", text: "drained-ok" }] } }
    }));
    const completed = await inflight;
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ result: { result: { content: [{ text: "drained-ok" }] } } });
  });
});

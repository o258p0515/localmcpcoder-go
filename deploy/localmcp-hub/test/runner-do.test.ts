import { describe, expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do";
import type { Env } from "../src/types";

class FakeSQL {
  rows = new Map<string, any>();
  exec(query: string, ...args: any[]) {
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
    fetch: async () => Response.json({ result: true })
  };
  const env = {
    REGISTRY_DO: { idFromName: () => "global", get: () => registryStub }
  } as unknown as Env;
  return { runner: new RunnerDO(state as any, env), socket, sql };
}

describe("RunnerDO disconnect handling", () => {
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
});

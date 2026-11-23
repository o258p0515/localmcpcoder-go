import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp-router";
import type { Env } from "../src/types";

function fakeEnv() {
  const runners = [{ runner_id: "r1", os: "linux", arch: "amd64", repo: "owner/repo", tags: ["go"], status: "online", connected_at: 1 }];
  const sessions = new Map<string, string>();
  const runnerCalls: any[] = [];
  const registryStub = {
    async fetch(_input: any, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      let result: any;
      switch (body.action) {
        case "listRunners": result = runners; break;
        case "getSessionRunner": result = sessions.get(body.session_key) ?? null; break;
        case "setSessionRunner":
          if (!runners.some((r) => r.runner_id === body.runner_id && r.status === "online")) return Response.json({ error: "runner is not online" }, { status: 500 });
          sessions.set(body.session_key, body.runner_id); result = { session_key: body.session_key, runner_id: body.runner_id }; break;
        default: result = null;
      }
      return Response.json({ result });
    }
  };
  const runnerStub = {
    async fetch(_input: any, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      runnerCalls.push(body);
      if (body.payload?.method === "tools/list") {
        return Response.json({ result: { jsonrpc: "2.0", id: "hub-tools-list", result: { tools: [{ name: "bash", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] } } });
      }
      if (body.async) return Response.json({ result: { status: "running", job_id: "job-1", runner_id: "r1" } });
      return Response.json({ result: { jsonrpc: "2.0", id: "rpc-1", result: { content: [{ type: "text", text: "ok" }] } } });
    }
  };
  const env = {
    REGISTRY_DO: { idFromName: () => "global", get: () => registryStub },
    RUNNER_DO: { idFromName: (id: string) => id, get: () => runnerStub }
  } as unknown as Env;
  return { env, sessions, runnerCalls };
}
function request(rpc: any, session = "session-1", headers: Record<string, string> = {}) {
  return new Request("https://hub.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": session, ...headers },
    body: JSON.stringify(rpc)
  });
}

describe("MCP Hub routing", () => {
  it("exposes meta tools before any runner is selected", async () => {
    const { env } = fakeEnv();
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, "session-1");
    const body = await response.json() as any;
    expect(body.result.tools.map((tool: any) => tool.name)).toEqual(["list_runners", "select_runner", "get_job_result"]);
  });
  it("pins a session and injects runner routing arguments into remote tool schemas", async () => {
    const { env } = fakeEnv();
    const selected = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "select_runner", arguments: { runner_id: "r1" } } }), env, "session-1");
    expect((await selected.json() as any).result.content[0].text).toContain("r1");
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, "session-1");
    const body = await response.json() as any;
    const bash = body.result.tools.find((tool: any) => tool.name === "bash");
    expect(bash.inputSchema.properties.runner_id.type).toBe("string");
    expect(bash.inputSchema.properties.async.type).toBe("boolean");
  });
  it("strips Hub-only arguments before forwarding and supports async jobs", async () => {
    const { env, runnerCalls } = fakeEnv();
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "pwd", runner_id: "r1", async: true } } }), env, "session-1");
    const body = await response.json() as any;
    expect(body.result.content[0].text).toContain("job-1");
    expect(runnerCalls[0].async).toBe(true);
    expect(runnerCalls[0].payload.params.arguments).toEqual({ command: "pwd" });
  });
});

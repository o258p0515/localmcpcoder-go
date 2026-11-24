import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp-router";
import type { Env } from "../src/types";

function fakeEnv(options: { runners?: any[]; failRunnerIds?: string[]; toolsByRunner?: Record<string, any[]> } = {}) {
  const runners = options.runners ?? [{ runner_id: "r1", os: "linux", arch: "amd64", repo: "owner/repo", tags: ["go"], status: "online", connected_at: 1 }];
  const sessions = new Map<string, string>();
  const runnerCalls: any[] = [];
  const registryCalls: any[] = [];
  const registryStub = {
    async fetch(_input: any, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      registryCalls.push(body.action);
      let result: any;
      switch (body.action) {
        case "listRunners": result = runners; break;
        case "resolveContext": result = { runners, selected_runner: sessions.get(body.session_key) ?? null }; break;
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
    async fetch(input: any, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const runnerId = (this as any).runnerId ?? "r1";
      runnerCalls.push({ input: String(input), body, runnerId });
      if (options.failRunnerIds?.includes(runnerId)) return Response.json({ error: "runner dispatch failed" }, { status: 503 });
      if (body.payload?.method === "tools/list") {
        const tools = options.toolsByRunner?.[runnerId] ?? [{ name: "bash", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
        return Response.json({ result: { jsonrpc: "2.0", id: "hub-tools-list", result: { tools } } });
      }
      if (String(input).includes("/job?")) return Response.json({ job_id: "job-1", tool_name: "bash", status: "completed", result: { jsonrpc: "2.0", id: "rpc-1", result: { content: [{ type: "text", text: "async ok" }] } }, created_at: 1, finished_at: 2 });
      if (body.async) return Response.json({ result: { status: "running", job_id: "job-1", runner_id: runnerId } });
      return Response.json({ result: { jsonrpc: "2.0", id: "rpc-1", result: { content: [{ type: "text", text: "ok" }] } } });
    }
  };
  const env = {
    REGISTRY_DO: { idFromName: () => "global", get: () => registryStub },
    RUNNER_DO: { idFromName: (id: string) => id, get: (id: string) => Object.assign(Object.create(runnerStub), { runnerId: id }) }
  } as unknown as Env;
  return { env, sessions, runnerCalls, registryCalls, runners };
}
function request(rpc: any, session = "session-1", headers: Record<string, string> = {}) {
  return new Request("https://hub.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": session, ...headers },
    body: JSON.stringify(rpc)
  });
}
async function listed(env: Env) {
  const response = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, "session-1");
  return (await response.json() as any).result.tools as any[];
}

describe("MCP Hub routing", () => {
  it("exposes all 16 baseline tools with runner_id and async when no runner is online", async () => {
    const { env } = fakeEnv({ runners: [] });
    const tools = await listed(env);
    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_runners", "select_runner", "get_job_result", "bash", "read_file", "write_file", "edit_file",
      "list_dir", "glob", "grep", "todo_write", "todo_read", "system_info", "skills_list", "skill_read", "skills_reload", "git_execute"
    ]);
    for (const tool of tools.slice(3)) {
      expect(tool.inputSchema.properties.runner_id.type).toBe("string");
      expect(tool.inputSchema.properties.async.type).toBe("boolean");
    }
  });

  it("exposes the complete catalog without selecting a runner", async () => {
    const { env } = fakeEnv();
    const tools = await listed(env);
    expect(tools.map((tool) => tool.name)).toContain("bash");
    const git = tools.find((tool) => tool.name === "git_execute");
    expect(git.inputSchema.required).toEqual(["operation", "account"]);
    expect(git.inputSchema.properties.operation.enum).toContain("clone");
    expect(git.inputSchema.properties).not.toHaveProperty("token");
    expect(git.inputSchema.properties).not.toHaveProperty("credential");
    expect(tools.find((tool) => tool.name === "read_file").inputSchema.required).toEqual(["file_path"]);
  });

  it("merges additional tools from every online runner without duplicating meta tools", async () => {
    const { env, runnerCalls } = fakeEnv({
      runners: [
        { runner_id: "r1", status: "online" },
        { runner_id: "r2", status: "online" }
      ],
      toolsByRunner: {
        r1: [
          { name: "list_runners", description: "duplicate meta", inputSchema: { type: "object", properties: {} } },
          { name: "bash", description: "shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
          { name: "custom_one", inputSchema: { type: "object", properties: {} } }
        ],
        r2: [{ name: "custom_two", inputSchema: { type: "object", properties: {} } }]
      }
    });
    const tools = await listed(env);
    const secondTools = await listed(env);
    expect(secondTools.map((tool) => tool.name)).toContain("custom_two");
    expect(tools.map((tool) => tool.name)).toContain("custom_one");
    expect(tools.map((tool) => tool.name)).toContain("custom_two");
    expect(tools.filter((tool) => tool.name === "list_runners")).toHaveLength(1);
    expect(runnerCalls.filter((call) => call.body.payload?.method === "tools/list")).toHaveLength(2);
  });

  it("falls back to the baseline catalog if every runner dispatch fails", async () => {
    const { env } = fakeEnv({ failRunnerIds: ["r1"] });
    const tools = await listed(env);
    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toContain("skills_reload");
    expect(tools.find((tool) => tool.name === "skills_reload").inputSchema.properties.runner_id.type).toBe("string");
  });

  it("formats SSE responses with real newlines", async () => {
    const { env } = fakeEnv({ runners: [] });
    const response = await handleMcp(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "session-1", { Accept: "text/event-stream" }),
      env,
      "session-1"
    );
    const text = await response.text();
    expect(text).toContain("event: message\ndata: ");
    expect(text.endsWith("\n\n")).toBe(true);
    expect(text).not.toContain("\\ndata:");
  });


  it("uses one combined RegistryDO request for list_runners and each routed tool call", async () => {
    const { env, registryCalls } = fakeEnv();
    await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_runners", arguments: {} } }), env, "session-1");
    expect(registryCalls).toEqual(["resolveContext"]);
    registryCalls.length = 0;
    await handleMcp(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bash", arguments: { command: "pwd" } } }), env, "session-1");
    expect(registryCalls).toEqual(["resolveContext"]);
  });

  it("pins a session and injects runner routing arguments into remote tool schemas", async () => {
    const { env } = fakeEnv();
    const selected = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "select_runner", arguments: { runner_id: "r1" } } }), env, "session-1");
    expect((await selected.json() as any).result.content[0].text).toContain("r1");
    const tools = await listed(env);
    const bash = tools.find((tool) => tool.name === "bash");
    expect(bash.inputSchema.properties.runner_id.type).toBe("string");
    expect(bash.inputSchema.properties.async.type).toBe("boolean");
  });

  it("routes git_execute to the isolated Git runner and normal tools to the Agent runner", async () => {
    const { env, runnerCalls } = fakeEnv({
      runners: [
        { runner_id: "agent-1", tags: ["linux", "agent"], status: "online" },
        { runner_id: "git-1", tags: ["linux", "git", "isolated"], status: "online" }
      ],
      toolsByRunner: {
        "agent-1": [{ name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
        "git-1": [{ name: "git_execute", inputSchema: { type: "object", properties: { operation: { type: "string" }, account: { type: "string" } }, required: ["operation", "account"] } }]
      }
    });
    await handleMcp(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } }), env, "session-1");
    await handleMcp(request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "git_execute", arguments: { operation: "status", account: "personal" } } }), env, "session-1");
    const calls = runnerCalls.filter((call) => call.body.payload?.method === "tools/call");
    expect(calls.map((call) => [call.runnerId, call.body.payload.params.name])).toEqual([
      ["agent-1", "bash"],
      ["git-1", "git_execute"]
    ]);
  });

  it("routes a tool to its compatible paired runner even when the session is pinned to the other role", async () => {
    const { env, runnerCalls } = fakeEnv({
      runners: [
        { runner_id: "agent-1", tags: ["linux", "agent"], status: "online" },
        { runner_id: "git-1", tags: ["linux", "git", "isolated"], status: "online" }
      ]
    });
    await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "select_runner", arguments: { runner_id: "agent-1" } } }), env, "session-1");
    await handleMcp(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "git_execute", arguments: { operation: "status", account: "personal" } } }), env, "session-1");
    await handleMcp(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "id" } } }), env, "session-1");
    const calls = runnerCalls.filter((call) => call.body.payload?.method === "tools/call");
    expect(calls.map((call) => call.runnerId)).toEqual(["git-1", "agent-1"]);
  });

  it("routes multiple concurrent Agent/Git pairs by their shared pair tag", async () => {
    const { env, runnerCalls } = fakeEnv({
      runners: [
        { runner_id: "agent-1", tags: ["linux", "agent", "pair:pool-1"], status: "online" },
        { runner_id: "git-1", tags: ["linux", "git", "isolated", "pair:pool-1"], status: "online" },
        { runner_id: "agent-2", tags: ["linux", "agent", "pair:pool-2"], status: "online" },
        { runner_id: "git-2", tags: ["linux", "git", "isolated", "pair:pool-2"], status: "online" }
      ]
    });
    const call = (id: number, name: string, arguments_: any) =>
      handleMcp(request({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } }), env, "session-1");
    await call(1, "select_runner", { runner_id: "agent-1" });
    await call(2, "git_execute", { operation: "status", account: "personal" });
    await call(3, "bash", { command: "id" });
    await call(4, "select_runner", { runner_id: "git-2" });
    await call(5, "git_execute", { operation: "status", account: "personal" });
    await call(6, "bash", { command: "id" });
    const calls = runnerCalls.filter((entry) => entry.body.payload?.method === "tools/call");
    expect(calls.map((entry) => entry.runnerId)).toEqual(["git-1", "agent-1", "git-2", "agent-2"]);
  });

  it("does not guess a pair when multiple untagged Git runners are online", async () => {
    const { env } = fakeEnv({
      runners: [
        { runner_id: "agent-1", tags: ["agent"], status: "online" },
        { runner_id: "git-1", tags: ["git", "isolated"], status: "online" },
        { runner_id: "git-2", tags: ["git", "isolated"], status: "online" }
      ]
    });
    await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "select_runner", arguments: { runner_id: "agent-1" } } }), env, "session-1");
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "git_execute", arguments: { operation: "status", account: "personal" } } }), env, "session-1");
    const body = await response.json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Multiple isolated Git runners");
  });

  it("returns the full async job status and result without unwrapping its result field", async () => {
    const { env } = fakeEnv();
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_job_result", arguments: { runner_id: "r1", job_id: "job-1" } } }), env, "session-1");
    const body = await response.json() as any;
    const job = JSON.parse(body.result.content[0].text);
    expect(job.status).toBe("completed");
    expect(job.result.result.content[0].text).toBe("async ok");
  });

  it("strips Hub-only arguments before forwarding and supports async jobs", async () => {
    const { env, runnerCalls } = fakeEnv();
    const response = await handleMcp(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "pwd", runner_id: "r1", async: true } } }), env, "session-1");
    const body = await response.json() as any;
    expect(body.result.content[0].text).toContain("job-1");
    expect(runnerCalls[0].body.async).toBe(true);
    expect(runnerCalls[0].body.payload.params.arguments).toEqual({ command: "pwd" });
  });
});
  240
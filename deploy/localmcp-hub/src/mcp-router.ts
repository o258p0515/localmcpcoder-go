import type { Env, RunnerInfo } from "./types";
import { pairedRunner } from "./runner-pairing";
import { injectRunnerArguments, stripRunnerArguments } from "./schema-injector";
import { runnerToolCatalog } from "./tool-catalog";

const json = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {})
});

async function registry(env: Env, payload: unknown): Promise<any> {
  const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("global"));
  const response = await stub.fetch("https://registry/internal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error ?? "registry request failed");
  return data.result;
}

async function runnerRequest(env: Env, id: string, path: string, body?: unknown): Promise<any> {
  const stub = env.RUNNER_DO.get(env.RUNNER_DO.idFromName(id));
  const response = await stub.fetch("https://runner/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error ?? "runner request failed");
  return path.startsWith("job?") ? data : (data.result ?? data);
}

function metaTools() {
  return [
    { name: "list_runners", description: "List connected LocalMCP runners and their status.", inputSchema: { type: "object", properties: {} } },
    { name: "select_runner", description: "Select the default runner for this MCP session.", inputSchema: { type: "object", properties: { runner_id: { type: "string", description: "Runner ID to pin to this session." } }, required: ["runner_id"] } },
    { name: "get_job_result", description: "Retrieve the status and result of an asynchronous tool call.", inputSchema: { type: "object", properties: { runner_id: { type: "string" }, job_id: { type: "string" } }, required: ["runner_id", "job_id"] } }
  ];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("runner tools/list timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function listRunnerTools(env: Env): Promise<any[]> {
  // tools/list is a catalog operation, not a routed tool call: inspect every
  // online runner without requiring a session selection or a unique runner.
  const baseline = injectRunnerArguments(runnerToolCatalog);
  const metaNames = new Set(metaTools().map((tool) => tool.name));
  let runners: RunnerInfo[] = [];
  try {
    runners = await registry(env, { action: "listRunners" }) as RunnerInfo[];
  } catch {
    return baseline;
  }
  const online = runners.filter((runner) => runner.status === "online");
  if (online.length === 0) return baseline;

  const catalogs = await Promise.all(online.map(async (runner) => {
    try {
      // A stalled runner must not prevent the Hub's static catalog from being
      // returned. The underlying request may finish later, but its result is
      // intentionally ignored after this bounded discovery window.
      const payload = await withTimeout(
        runnerRequest(env, runner.runner_id, "dispatch", {
          payload: { jsonrpc: "2.0", id: "hub-tools-list", method: "tools/list", params: {} },
          tool_name: "tools/list"
        }),
        5_000
      );
      return payload?.result?.tools ?? [];
    } catch {
      return [];
    }
  }));

  const merged = new Map<string, any>();
  for (const tool of baseline) merged.set(tool.name, tool);
  for (const tools of catalogs) {
    for (const tool of injectRunnerArguments(tools)) {
      if (tool && typeof tool.name === "string" && tool.name && !metaNames.has(tool.name)) {
        merged.set(tool.name, tool);
      }
    }
  }
  return [...merged.values()];
}

async function resolveRunner(env: Env, session: string, headerId: string, argumentId?: string, toolName = ""): Promise<{ runner?: RunnerInfo; runners: RunnerInfo[]; error?: string }> {
  const runners = await registry(env, { action: "listRunners" }) as RunnerInfo[];
  const online = runners.filter((r) => r.status === "online");
  const explicit = argumentId || headerId;
  if (explicit) {
    const runner = online.find((r) => r.runner_id === explicit);
    if (!runner) return { runners, error: `Runner "${explicit}" is not online. Call list_runners.` };
    return { runner, runners };
  }

  const selectedId = await registry(env, { action: "getSessionRunner", session_key: session });
  const selected = online.find((r) => r.runner_id === selectedId);
  const hasTag = (runner: RunnerInfo | undefined, tag: string) => !!runner?.tags?.includes(tag);
  const gitRunners = online.filter((runner) => hasTag(runner, "git") && hasTag(runner, "isolated"));
  const agentRunners = online.filter((runner) => hasTag(runner, "agent"));

  // Keep the Agent and Git-only processes paired behind one Hub endpoint.
  // An explicit runner_id always wins; otherwise choose a runner by tool role,
  // even when the session's default runner is the other half of the pair.
  if (toolName === "git_execute") {
    if (hasTag(selected, "git") && hasTag(selected, "isolated")) return { runner: selected, runners };
    const pairedGit = pairedRunner(selected, gitRunners);
    if (pairedGit) return { runner: pairedGit, runners };
    if (gitRunners.length === 1) return { runner: gitRunners[0], runners };
    if (gitRunners.length > 1) return { runners, error: "Multiple isolated Git runners are online. Pass runner_id to select one." };
    return { runners, error: "No online isolated Git executor runner. Start a runner tagged git,isolated, then call list_runners." };
  }

  if (hasTag(selected, "agent")) return { runner: selected, runners };
  const pairedAgent = pairedRunner(selected, agentRunners);
  if (pairedAgent) return { runner: pairedAgent, runners };
  if (agentRunners.length === 1) return { runner: agentRunners[0], runners };
  if (agentRunners.length > 1) return { runners, error: "Multiple Agent runners are online. Pass runner_id to select one." };
  if (selected && !hasTag(selected, "git")) return { runner: selected, runners };
  if (online.length === 1 && !hasTag(online[0], "git")) return { runner: online[0], runners };
  if (online.length === 0) return { runners, error: "No online runner. Start a LocalMCP Hub runner, then call list_runners." };
  return { runners, error: "No online Agent runner. Start a runner tagged agent, then call list_runners." };
}

async function processRequest(request: Request, env: Env, session: string, rpc: any): Promise<any> {
  const id = rpc.id ?? null;
  const method = String(rpc.method ?? "");
  const params = rpc.params ?? {};
  if (method === "initialize") return json(id, {
    protocolVersion: params.protocolVersion ?? "2025-03-26",
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "localmcp-hub", version: "1.0.0" },
    instructions: "Use list_runners to inspect available machines. Use select_runner to pin this session or runner_id to route an individual tool call."
  });
  if (method === "ping") return json(id, {});
  if (method.startsWith("notifications/")) return null;
  if (method === "tools/list") {
    const tools = await listRunnerTools(env);
    return json(id, { tools: [...metaTools(), ...tools] });
  }
  if (method !== "tools/call") return error(id, -32601, "Method not found");
  const name = String(params.name ?? "");
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;

  if (name === "list_runners") {
    const runners = await registry(env, { action: "listRunners" }) as RunnerInfo[];
    const selected = await registry(env, { action: "getSessionRunner", session_key: session });
    return json(id, textResult({ runners, selected_runner: selected }));
  }
  if (name === "select_runner") {
    const runnerId = String(args.runner_id ?? "");
    if (!runnerId) return json(id, textResult("runner_id is required", true));
    try {
      const selected = await registry(env, { action: "setSessionRunner", session_key: session, runner_id: runnerId });
      return json(id, textResult(selected));
    } catch (e) { return json(id, textResult(e instanceof Error ? e.message : String(e), true)); }
  }
  if (name === "get_job_result") {
    const runnerId = String(args.runner_id ?? "");
    const jobId = String(args.job_id ?? "");
    if (!runnerId || !jobId) return json(id, textResult("runner_id and job_id are required", true));
    try { return json(id, textResult(await runnerRequest(env, runnerId, "job?job_id=" + encodeURIComponent(jobId)))); }
    catch (e) { return json(id, textResult(e instanceof Error ? e.message : String(e), true)); }
  }

  const stripped = stripRunnerArguments(args);
  const selected = await resolveRunner(env, session, request.headers.get("X-Runner-Id") ?? "", stripped.runnerId, name);
  if (!selected.runner) return json(id, textResult({ error: selected.error, runners: selected.runners }, true));
  try {
    const payload = await runnerRequest(env, selected.runner.runner_id, "dispatch", {
      payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: stripped.args } },
      async: stripped.async, tool_name: name
    });
    if (payload?.status === "running") return json(id, textResult(payload));
    return json(id, payload?.result ?? textResult(payload));
  } catch (e) {
    return json(id, textResult(e instanceof Error ? e.message : String(e), true));
  }
}

export async function handleMcp(request: Request, env: Env, session: string): Promise<Response> {
  if (request.method !== "POST") return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
  let rpc: any;
  try { rpc = await request.json(); } catch { return new Response("invalid JSON", { status: 400 }); }
  if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") return Response.json(error(rpc?.id, -32600, "Invalid Request"), { status: 400 });
  if (rpc.method.startsWith("notifications/")) return new Response(null, { status: 202, headers: { "Mcp-Session-Id": session } });
  const result = processRequest(request, env, session, rpc);
  const headers = new Headers({ "Mcp-Session-Id": session, "Cache-Control": "no-cache" });
  if ((request.headers.get("Accept") ?? "").includes("text/event-stream")) {
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("X-Accel-Buffering", "no");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const keepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { clearInterval(keepalive); }
        }, 20_000);
        void result.then((message) => {
          if (message !== null) controller.enqueue(encoder.encode("event: message\ndata: " + JSON.stringify(message) + "\n\n"));
          clearInterval(keepalive);
          controller.close();
        }).catch((e) => {
          controller.enqueue(encoder.encode("event: message\ndata: " + JSON.stringify(error(rpc.id, -32603, String(e))) + "\n\n"));
          clearInterval(keepalive);
          controller.close();
        });
      }
    });
    return new Response(stream, { headers });
  }
  try { return Response.json(await result, { headers }); }
  catch (e) { return Response.json(error(rpc.id, -32603, e instanceof Error ? e.message : String(e)), { headers }); }
}

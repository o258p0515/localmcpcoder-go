const endpoint = `https://${process.env.HUB_DOMAIN}/mcp`;
const token = process.env.MCP_TOKEN;
const session = `hub-e2e-${process.env.GITHUB_RUN_ID}`;
const runnerA = process.env.RUNNER_A;
const runnerB = process.env.RUNNER_B;
const pidA = Number(process.env.RUNNER_A_PID);
const pidB = Number(process.env.RUNNER_B_PID);
let rpcId = 0;

if (!process.env.HUB_DOMAIN || !token || !runnerA || !runnerB) {
  throw new Error("HUB_DOMAIN, MCP_TOKEN, RUNNER_A and RUNNER_B are required");
}

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Mcp-Session-Id": session
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Hub ${method} returned HTTP ${response.status}: ${body}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(`Hub returned invalid JSON for ${method}: ${body}`); }
  if (parsed.error) throw new Error(`Hub RPC ${method} failed: ${JSON.stringify(parsed.error)}`);
  return parsed;
}

async function callTool(name, args = {}) {
  const response = await rpc("tools/call", { name, arguments: args });
  if (response.result?.isError) throw new Error(`Tool ${name} failed: ${textOf(response.result)}`);
  return response.result;
}
function textOf(result) {
  return result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
}
function parseText(result, label) {
  const text = textOf(result);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} did not return JSON text: ${text}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listTaggedRunners() {
  const data = parseText(await callTool("list_runners"), "list_runners");
  return (data.runners ?? []).filter((runner) => runner.runner_id === runnerA || runner.runner_id === runnerB);
}
async function waitForBoth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let found = [];
  while (Date.now() < deadline) {
    found = await listTaggedRunners();
    if (found.some((r) => r.runner_id === runnerA && r.status === "online") &&
        found.some((r) => r.runner_id === runnerB && r.status === "online")) return found;
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for both runners. Found: ${JSON.stringify(found)}`);
}
async function stopRunners() {
  for (const pid of [pidA, pidB]) {
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const remaining = await listTaggedRunners();
      if (remaining.length === 0) {
        console.log("Both runners gracefully drained and unregistered from Hub.");
        return;
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error("Runners did not unregister from Hub within 45 seconds after SIGTERM");
}

let testError;
try {
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "localmcp-hub-e2e", version: "1" }
  });

  console.log("Waiting for two Hub runners...");
  const online = await waitForBoth();
  console.log("Two runners connected:", online.map((r) => ({ runner_id: r.runner_id, status: r.status, tags: r.tags })));

  await callTool("select_runner", { runner_id: runnerA });
  const tools = await rpc("tools/list", {});
  const bash = tools.result?.tools?.find((tool) => tool.name === "bash");
  if (!bash?.inputSchema?.properties?.runner_id || !bash?.inputSchema?.properties?.async) {
    throw new Error("Hub did not inject runner_id and async into the remote bash schema");
  }

  const selected = textOf(await callTool("bash", { command: "printf 'selected-runner-a'" }));
  if (!selected.includes("selected-runner-a")) throw new Error(`Session-pinned runner A failed: ${selected}`);

  const directB = textOf(await callTool("bash", { command: "printf 'direct-runner-b'", runner_id: runnerB }));
  if (!directB.includes("direct-runner-b")) throw new Error(`Explicit runner B routing failed: ${directB}`);

  const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) => {
    const marker = `parallel-${index}`;
    const runner_id = index % 2 === 0 ? runnerA : runnerB;
    return callTool("bash", { command: `sleep 3; printf '${marker}'`, runner_id });
  }));
  for (let index = 0; index < concurrent.length; index++) {
    if (!textOf(concurrent[index]).includes(`parallel-${index}`)) {
      throw new Error(`Concurrent request ${index} was not routed correctly: ${textOf(concurrent[index])}`);
    }
  }
  console.log("Session pinning, explicit cross-runner routing and 6 concurrent calls passed.");

  const longResult = await callTool("bash", {
    command: "sleep 70 && printf 'async-auto-complete'",
    runner_id: runnerA
  });
  const longState = parseText(longResult, "long-running bash");
  if (longState.status !== "running" || !longState.job_id) {
    throw new Error(`A request over 45 seconds did not transition to an async job: ${JSON.stringify(longState)}`);
  }
  let job;
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    job = parseText(await callTool("get_job_result", { runner_id: runnerA, job_id: longState.job_id }), "get_job_result");
    if (job.status === "completed" || job.status === "failed") break;
    await sleep(4000);
  }
  if (job?.status !== "completed") throw new Error(`Async job did not complete successfully: ${JSON.stringify(job)}`);
  const jobOutput = job.result?.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
  if (!jobOutput.includes("async-auto-complete")) {
    throw new Error(`Async job result did not contain the expected output: ${jobOutput}`);
  }
  console.log("45-second async transition and durable job-result retrieval passed.");
} catch (error) {
  testError = error;
} finally {
  try { await stopRunners(); }
  catch (cleanupError) { testError = testError ?? cleanupError; }
}
if (testError) throw testError;
console.log("LocalMCP Hub two-runner E2E passed.");

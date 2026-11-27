import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end verification for Issue #79 (Zero-Downtime Make-Before-Break Handover & Idle Timeout).
 *
 * Usage (against a live Hub Worker):
 *   HUB_DOMAIN=hub.example.com MCP_TOKEN=... RUNNER_BIN=/path/to/localmcpcoder-mcp node scripts/e2e-handover.mjs
 *
 * When HUB_DOMAIN is set, connects real compiled Go runners to the live Hub and verifies:
 *   1. Gen 1 starts with duration_seconds=300, handover_after=10 and pins a session.
 *   2. While an in-flight bash request (sleep 4) is running on Gen 1, Gen 2 connects with --predecessor-id=<gen1>.
 *   3. Hub atomically migrates the session to Gen 2 and sends WebSocket {"type":"shutdown"} to Gen 1.
 *   4. Gen 1 finishes the in-flight request cleanly and exits with code 0.
 *   5. Subsequent session calls route seamlessly to Gen 2 without re-calling select_runner.
 *   6. An idle runner with --idle-timeout=3 drains and exits cleanly with code 0.
 */

const hubDomain = process.env.HUB_DOMAIN;
const hubBaseUrl = process.env.HUB_BASE_URL || (hubDomain ? `https://${hubDomain}` : "");
const token = process.env.MCP_TOKEN;
const runnerBin = process.env.RUNNER_BIN;

if (!hubBaseUrl || !token || !runnerBin) {
  throw new Error("HUB_DOMAIN (or HUB_BASE_URL), MCP_TOKEN, and RUNNER_BIN are required.");
}

const endpoint = `${hubBaseUrl.replace(/\/+$/, "")}/mcp`;
const runTag = process.env.GITHUB_RUN_ID || String(Date.now());
const session = `handover-e2e-${runTag}`;
const gen1Id = `handover-g1-${runTag}`;
const gen2Id = `handover-g2-${runTag}`;
const idleId = `handover-idle-${runTag}`;
let rpcId = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const parsed = JSON.parse(body);
  if (parsed.error) throw new Error(`Hub RPC ${method} failed: ${JSON.stringify(parsed.error)}`);
  return parsed;
}

function textOf(result) {
  return result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function callTool(name, args = {}) {
  const response = await rpc("tools/call", { name, arguments: args });
  if (response.result?.isError) throw new Error(`Tool ${name} failed: ${textOf(response.result)}`);
  return response.result;
}

async function listRunners() {
  const res = await callTool("list_runners");
  return JSON.parse(textOf(res));
}

async function waitForRunner(id, logs = [], timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await listRunners();
    const match = (data.runners ?? []).find((r) => r.runner_id === id && r.status === "online");
    if (match) return match;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for runner ${id} to become online\nLogs:\n${logs.join("")}`);
}

function waitForExit(child, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`${label} exited via signal ${signal}`));
      resolve(code);
    });
  });
}

function startRunner(args, rootDir, port) {
  const logs = [];
  const child = spawn(runnerBin, [
    "--root", rootDir,
    "--port", String(port),
    "--tunnel", "hub",
    "--hub-urls", hubBaseUrl,
    ...args
  ], {
    env: { ...process.env, MCP_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
  return { child, logs };
}

const workRoot = mkdtempSync(join(tmpdir(), "localmcp-handover-e2e-"));
const dirG1 = join(workRoot, "g1");
const dirG2 = join(workRoot, "g2");
const dirIdle = join(workRoot, "idle");
mkdirSync(dirG1, { recursive: true });
mkdirSync(dirG2, { recursive: true });
mkdirSync(dirIdle, { recursive: true });
const procs = [];

try {
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "localmcp-handover-e2e", version: "1" }
  });

  const basePort = Number(process.env.E2E_BASE_PORT || (20000 + (process.pid % 10000)));
  // 1. Start Gen 1 runner
  const g1 = startRunner([
    "--runner-id", gen1Id,
    "--runner-tags", "provider:github,os:linux,agent,e2e-handover",
    "--duration-seconds", "300",
    "--handover-after", "5",
    "--generation", "1"
  ], dirG1, basePort);
  procs.push(g1.child);
  await waitForRunner(gen1Id, g1.logs);
  await callTool("select_runner", { runner_id: gen1Id });

  const ping1 = textOf(await callTool("bash", { command: "printf 'on-gen1'" }));
  if (!ping1.includes("on-gen1")) throw new Error(`Expected Gen 1 output, got: ${ping1}`);

  // 2. Start an in-flight request on Gen 1, then bring Gen 2 online with --predecessor-id
  const inflightPromise = callTool("bash", { command: "sleep 4 && printf 'inflight-survived'" });
  await sleep(1000);

  const g2 = startRunner([
    "--runner-id", gen2Id,
    "--runner-tags", "provider:github,os:linux,agent,e2e-handover",
    "--duration-seconds", "300",
    "--handover-after", "-1",
    "--predecessor-id", gen1Id,
    "--generation", "2"
  ], dirG2, basePort + 1);
  procs.push(g2.child);
  await waitForRunner(gen2Id, g2.logs);

  // 3. In-flight request on Gen 1 must succeed and Gen 1 must exit cleanly with code 0
  const inflightOutput = textOf(await inflightPromise);
  if (!inflightOutput.includes("inflight-survived")) {
    throw new Error(`In-flight request did not survive cutover: ${inflightOutput}`);
  }
  const g1Code = await waitForExit(g1.child, "Gen 1 runner", 25_000);
  if (g1Code !== 0) {
    throw new Error(`Gen 1 runner exited with non-zero code ${g1Code}\nLogs:\n${g1.logs.join("")}`);
  }

  // 4. Subsequent session calls route automatically to Gen 2 without select_runner
  const contextAfter = await listRunners();
  if (contextAfter.selected_runner !== gen2Id) {
    throw new Error(`Expected session selected_runner=${gen2Id}, got ${contextAfter.selected_runner}`);
  }
  const ping2 = textOf(await callTool("bash", { command: `printf 'now-on-gen2'` }));
  if (!ping2.includes("now-on-gen2")) throw new Error(`Expected Gen 2 output, got: ${ping2}`);

  // 5. Verify idle-timeout runner exits cleanly with code 0 without spawning
  const idle = startRunner([
    "--runner-id", idleId,
    "--runner-tags", "provider:github,os:linux,agent,e2e-idle",
    "--idle-timeout", "3",
    "--handover-after", "-1"
  ], dirIdle, basePort + 2);
  procs.push(idle.child);
  await waitForRunner(idleId, idle.logs);
  const idleCode = await waitForExit(idle.child, "Idle runner", 20_000);
  if (idleCode !== 0) {
    throw new Error(`Idle runner exited with non-zero code ${idleCode}\nLogs:\n${idle.logs.join("")}`);
  }

  console.log("LocalMCP Hub Zero-Downtime Handover & Idle-Timeout E2E PASSED.");
} finally {
  for (const child of procs) {
    if (child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
  await sleep(1500);
  for (const child of procs) {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  rmSync(workRoot, { recursive: true, force: true });
}

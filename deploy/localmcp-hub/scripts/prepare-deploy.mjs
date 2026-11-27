import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cf, required, resolveZone, verifyIdentity } from "./cloudflare.mjs";
import { isIsolatedPartialHubWorker, renderDeployWranglerConfig } from "./worker-safety.mjs";

function mask(value) { process.stdout.write("::add-mask::" + value + "\n"); }
function exportValue(name, value, secret = true) {
  if (secret) mask(value);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, name + "=" + value + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, name.toLowerCase() + "=" + value + "\n");
}

await verifyIdentity();
const zone = await resolveZone();
const hubDomain = "hub." + zone.zoneName;
const records = await cf("GET", `/zones/${zone.zoneId}/dns_records?name=${encodeURIComponent(hubDomain)}`);
if (records.length) {
  const reusable = records.length === 1 && records[0].type === "CNAME" &&
    String(records[0].content).toLowerCase().replace(/\.$/, "") === zone.zoneName.toLowerCase() && records[0].proxied === true;
  if (!reusable) throw new Error(`DNS name ${hubDomain} already has a record. Refusing to modify or take over an existing hostname.`);
} else {
  await cf("POST", `/zones/${zone.zoneId}/dns_records`, {
    type: "CNAME", name: hubDomain, content: zone.zoneName, proxied: true,
    comment: "LocalMCP Hub Worker route"
  });
}

const routes = await cf("GET", `/zones/${zone.zoneId}/workers/routes`);
const existingRoute = routes.find((route) => route.pattern === hubDomain + "/*");
if (existingRoute && existingRoute.script !== "localmcp-hub") {
  throw new Error(`Worker route ${hubDomain}/* is already assigned to another Worker (${existingRoute.script ?? "unknown"}). Refusing to overwrite it.`);
}

const workerRecords = await cf("GET", `/accounts/${zone.accountId}/workers/workers?per_page=100`);
let existingWorker = workerRecords.find((worker) => worker.name === "localmcp-hub");
if (existingWorker) {
  const references = existingWorker.references ?? {};
  console.log("Existing Cloudflare Worker metadata:", JSON.stringify({
    id: existingWorker.id, name: existingWorker.name, created_on: existingWorker.created_on,
    updated_on: existingWorker.updated_on, deployed_on: existingWorker.deployed_on ?? null,
    tags: existingWorker.tags ?? [], subdomain: existingWorker.subdomain ?? null,
    reference_counts: Object.fromEntries(Object.entries(references).map(([key, value]) => [key, Array.isArray(value) ? value.length : null])),
    routeAssignedToHub: existingRoute?.script === "localmcp-hub"
  }));
}

if (!existingWorker) {
  existingWorker = await cf("POST", `/accounts/${zone.accountId}/workers/workers`, {
    name: "localmcp-hub", logpush: false, tags: ["localmcp-hub-managed"],
    subdomain: { enabled: false }
  });
  console.log("Created dedicated Cloudflare Worker metadata record localmcp-hub.");
} else if (!(existingWorker.tags ?? []).includes("localmcp-hub-managed") &&
           (!existingRoute || existingRoute.script !== "localmcp-hub")) {
  const references = existingWorker.references ?? {};
  const referenceCounts = Object.fromEntries(
    Object.entries(references).map(([key, value]) => [key, Array.isArray(value) ? value.length : null])
  );
  const safeToAdopt = isIsolatedPartialHubWorker(existingWorker, existingRoute);
  console.log("Worker adoption safety checks:", JSON.stringify({
    age_ms: Date.now() - Date.parse(existingWorker.created_on ?? ""),
    created_equals_deployed: Date.parse(existingWorker.created_on ?? "") === Date.parse(existingWorker.deployed_on ?? ""),
    subdomain_enabled: existingWorker.subdomain?.enabled ?? null,
    reference_counts: referenceCounts,
    only_expected_durable_object_bindings: safeToAdopt,
    route_exists: !!existingRoute
  }));
  if (!safeToAdopt) {
    throw new Error("A Worker named localmcp-hub already exists but cannot be proven to be the isolated partial Hub resource; refusing to overwrite it.");
  }
  const tags = [...new Set([...(existingWorker.tags ?? []), "localmcp-hub-managed"])];
  existingWorker = await cf(
    "PATCH",
    `/accounts/${zone.accountId}/workers/workers/${encodeURIComponent(existingWorker.id)}`,
    { tags }
  );
  console.log("Adopted the isolated partial Hub Worker metadata; only its management tag was changed.");
}

const token = required("MCP_TOKEN");
if (token.length < 32) throw new Error("MCP_TOKEN must be at least 32 characters");
const admin = createHmac("sha256", token)
  .update("localmcp-hub-admin-v1:" + hubDomain)
  .digest("hex");
const template = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const { configText: deployConfig, proxyServiceBound, proxyWorkerName } = renderDeployWranglerConfig(template, {
  accountId: zone.accountId,
  hubDomain,
  zoneName: zone.zoneName,
  workerRecords
});
writeFileSync(new URL("../wrangler.deploy.jsonc", import.meta.url), deployConfig, { mode: 0o600 });
if (proxyServiceBound) {
  console.log(`Auto-bound internal Cloudflare Service Binding MCP_PROXY -> Worker ${proxyWorkerName} for zero-config handover.`);
} else {
  console.log("Companion Worker github-mcp-proxy not found in account; skipping optional MCP_PROXY Service Binding.");
}
exportValue("HUB_DOMAIN", hubDomain, false);
exportValue("ADMIN_TOKEN", admin);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "zone_name=" + zone.zoneName + "\n");
console.log(`Prepared isolated Hub hostname https://${hubDomain}; existing CF_DOMAIN and unrelated Worker routes were not changed.`);

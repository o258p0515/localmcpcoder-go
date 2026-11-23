import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cf, required, resolveZone, verifyIdentity } from "./cloudflare.mjs";
function mask(value) { process.stdout.write("::add-mask::" + value + "\n"); }
function exportValue(name, value) {
  mask(value);
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
  await cf("POST", `/zones/${zone.zoneId}/dns_records`, { type: "CNAME", name: hubDomain, content: zone.zoneName, proxied: true, comment: "LocalMCP Hub Worker route" });
}
const routes = await cf("GET", `/zones/${zone.zoneId}/workers/routes`);
const existingRoute = routes.find((route) => route.pattern === hubDomain + "/*");
if (existingRoute && existingRoute.script !== "localmcp-hub") {
  throw new Error(`Worker route ${hubDomain}/* is already assigned to another Worker (${existingRoute.script ?? "unknown"}). Refusing to overwrite it.`);
}
const workerRecords = await cf("GET", `/accounts/${zone.accountId}/workers/workers?per_page=100`);
let existingWorker = workerRecords.find((worker) => worker.name === "localmcp-hub");
if (existingWorker) {
  console.log("Existing Cloudflare Worker metadata:", JSON.stringify({
    id: existingWorker.id, name: existingWorker.name, created_on: existingWorker.created_on,
    updated_on: existingWorker.updated_on, deployed_on: existingWorker.deployed_on ?? null,
    tags: existingWorker.tags ?? [], subdomain: existingWorker.subdomain ?? null,
    routeAssignedToHub: existingRoute?.script === "localmcp-hub"
  }));
}
if (!existingWorker) {
  existingWorker = await cf("POST", `/accounts/${zone.accountId}/workers/workers`, {
    name: "localmcp-hub", logpush: false, tags: ["localmcp-hub-managed"], subdomain: { enabled: false }
  });
  console.log("Created dedicated Cloudflare Worker metadata record localmcp-hub.");
} else if (!(existingWorker.tags ?? []).includes("localmcp-hub-managed") &&
           (!existingRoute || existingRoute.script !== "localmcp-hub")) {
  const createdAt = Date.parse(existingWorker.created_on ?? "");
  const deployedAt = Date.parse(existingWorker.deployed_on ?? "");
  const references = existingWorker.references ?? {};
  const externalReferenceKeys = ["workers", "domains", "dispatch_namespace_outbounds", "queues"];
  const hasExternalReferences = externalReferenceKeys.some((key) => Array.isArray(references[key]) && references[key].length > 0);
  const durableObjectReferenceCount = Array.isArray(references.durable_objects) ? references.durable_objects.length : 0;
  // A failed first Wrangler upload created this exact isolated metadata record
  // but stopped before the custom route was attached. It is safe to adopt only
  // while it is recent, has no consumers, and has no public workers.dev subdomain.
  console.log("Worker adoption safety checks:", JSON.stringify({
    age_ms: Number.isFinite(createdAt) ? Date.now() - createdAt : null,
    created_equals_deployed: createdAt === deployedAt,
    subdomain_enabled: existingWorker.subdomain?.enabled ?? null,
    has_external_references: hasExternalReferences,
    durable_object_reference_count: durableObjectReferenceCount,
    reference_counts: Object.fromEntries(Object.entries(references).map(([key, value]) => [key, Array.isArray(value) ? value.length : null])),
    route_exists: !!existingRoute
  }));
  const partialHubUpload = Number.isFinite(createdAt) && Number.isFinite(deployedAt) &&
    Date.now() >= createdAt && Date.now() - createdAt <= 30 * 60 * 1000 &&
    deployedAt === createdAt && existingWorker.subdomain?.enabled === false &&
    !hasExternalReferences && durableObjectReferenceCount === 2 && !existingRoute;
  if (!partialHubUpload) {
    throw new Error("A Worker named localmcp-hub already exists but cannot be proven to be the isolated partial Hub resource created by the failed first upload; refusing to overwrite it.");
  }
  const tags = [...new Set([...(existingWorker.tags ?? []), "localmcp-hub-managed"])];
  existingWorker = await cf("PATCH", `/accounts/${zone.accountId}/workers/workers/${encodeURIComponent(existingWorker.id)}`, { tags });
  console.log("Adopted the isolated Worker metadata from the failed first Hub upload; only its management tag was changed.");
}
const token = required("MCP_TOKEN");
if (token.length < 32) throw new Error("MCP_TOKEN must be at least 32 characters");
const shared = createHmac("sha256", token).update("localmcp-hub-internal-v1:" + hubDomain).digest("hex");
const admin = createHmac("sha256", token).update("localmcp-hub-admin-v1:" + hubDomain).digest("hex");
const template = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const deployConfig = template.replace("__ACCOUNT_ID__", zone.accountId).replaceAll("__HUB_DOMAIN__", hubDomain).replaceAll("__ZONE_NAME__", zone.zoneName);
if (deployConfig.includes("__ACCOUNT_ID__") || deployConfig.includes("__HUB_DOMAIN__") || deployConfig.includes("__ZONE_NAME__")) throw new Error("Failed to render Wrangler deployment configuration");
writeFileSync(new URL("../wrangler.deploy.jsonc", import.meta.url), deployConfig, { mode: 0o600 });
exportValue("HUB_DOMAIN", hubDomain);
exportValue("HUB_SHARED_SECRET", shared);
exportValue("ADMIN_TOKEN", admin);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "zone_name=" + zone.zoneName + "\n");
console.log(`Prepared isolated Hub hostname https://${hubDomain}; existing CF_DOMAIN and unrelated Worker routes were not changed.`);

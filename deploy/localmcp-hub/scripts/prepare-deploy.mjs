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

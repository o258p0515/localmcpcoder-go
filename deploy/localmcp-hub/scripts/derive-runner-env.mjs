import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { required, resolveZone, verifyIdentity } from "./cloudflare.mjs";
await verifyIdentity();
const zone = await resolveZone();
const domain = "hub." + zone.zoneName;
const token = required("MCP_TOKEN");
if (token.length < 32) throw new Error("MCP_TOKEN must be at least 32 characters");
const secret = createHmac("sha256", token).update("localmcp-hub-internal-v1:" + domain).digest("hex");
for (const value of [domain, secret]) process.stdout.write("::add-mask::" + value + "\n");
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, "HUB_DOMAIN=" + domain + "\n");
  appendFileSync(process.env.GITHUB_ENV, "HUB_SHARED_SECRET=" + secret + "\n");
}
console.log("Resolved Hub runner target " + domain + "; internal secret derived and masked.");

export const API = "https://api.cloudflare.com/client/v4";
export function required(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
export async function cf(method, path, body) {
  const email = required("CF_API_EMAIL"), key = required("CF_API_KEY");
  const response = await fetch(API + path, { method, headers: { "X-Auth-Email": email, "X-Auth-Key": key, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    const details = (data.errors ?? []).map((e) => e.message ?? e.code).join("; ");
    throw new Error(`Cloudflare API ${method} ${path} failed (HTTP ${response.status}): ${details || "invalid response"}`);
  }
  return data.result;
}
export async function resolveZone() {
  const host = required("CF_DOMAIN").toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host)) throw new Error("CF_DOMAIN must be a bare DNS hostname");
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    const zones = await cf("GET", "/zones?name=" + encodeURIComponent(candidate));
    if (zones.length) {
      const zone = zones[0];
      if (!zone.account?.id || !zone.id || !zone.name) throw new Error("Cloudflare zone response lacks account or zone identifiers");
      return { host, zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id };
    }
  }
  throw new Error(`No Cloudflare zone found for ${host}; check CF_DOMAIN and Zone:Zone:Read access`);
}
export async function verifyIdentity() {
  const user = await cf("GET", "/user");
  if (!user.email || String(user.email).toLowerCase() !== required("CF_API_EMAIL").toLowerCase()) {
    throw new Error("CF_API_EMAIL does not match the Cloudflare Global API Key identity");
  }
}

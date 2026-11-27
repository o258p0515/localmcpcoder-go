/**
 * A previous Wrangler upload can leave a Worker metadata shell with its two
 * Durable Object class references before the custom route is attached.
 * Adoption is permitted only for that narrow, verifiable partial-upload shape.
 */
export function isIsolatedPartialHubWorker(worker, existingRoute, now = Date.now()) {
  if (!worker || worker.name !== "localmcp-hub" || existingRoute) return false;

  const createdAt = Date.parse(worker.created_on ?? "");
  const deployedAt = Date.parse(worker.deployed_on ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(deployedAt)) return false;

  const references = worker.references ?? {};
  const durableObjects = references.durable_objects;
  const hasExactlyTwoDurableObjectReferences = Array.isArray(durableObjects) && durableObjects.length === 2;
  const hasUnexpectedReferences = Object.entries(references).some(([key, value]) =>
    key !== "durable_objects" && Array.isArray(value) && value.length > 0
  );

  return now >= createdAt &&
    now - createdAt <= 30 * 60 * 1000 &&
    createdAt === deployedAt &&
    worker.subdomain?.enabled === false &&
    hasExactlyTwoDurableObjectReferences &&
    !hasUnexpectedReferences;
}

/**
 * Renders wrangler.deploy.jsonc and automatically attaches the internal
 * MCP_PROXY Cloudflare Service Binding when the companion github-mcp-proxy
 * Worker exists in the same Cloudflare account (zero manual config required).
 */
export function renderDeployWranglerConfig(template, { accountId, hubDomain, zoneName, workerRecords = [], proxyWorkerName = "github-mcp-proxy" }) {
  const rendered = template
    .replace("__ACCOUNT_ID__", accountId)
    .replaceAll("__HUB_DOMAIN__", hubDomain)
    .replaceAll("__ZONE_NAME__", zoneName);
  if (rendered.includes("__ACCOUNT_ID__") || rendered.includes("__HUB_DOMAIN__") || rendered.includes("__ZONE_NAME__")) {
    throw new Error("Failed to render Wrangler deployment configuration");
  }
  const parsed = JSON.parse(rendered);
  const proxyWorker = Array.isArray(workerRecords)
    ? workerRecords.find((worker) => worker?.name === proxyWorkerName)
    : undefined;
  let proxyServiceBound = false;
  if (proxyWorker) {
    const existing = Array.isArray(parsed.services) ? parsed.services : [];
    if (!existing.some((svc) => svc?.binding === "MCP_PROXY")) {
      parsed.services = [...existing, { binding: "MCP_PROXY", service: proxyWorkerName }];
    }
    proxyServiceBound = true;
  }
  return {
    configText: JSON.stringify(parsed, null, 2) + "\n",
    proxyServiceBound,
    proxyWorkerName: proxyServiceBound ? proxyWorkerName : null
  };
}

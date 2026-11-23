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

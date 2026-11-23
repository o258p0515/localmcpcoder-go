import { describe, expect, it } from "vitest";
import { isIsolatedPartialHubWorker } from "../scripts/worker-safety.mjs";

const now = Date.parse("2026-11-23T11:20:50.000Z");
function partialWorker(overrides: Record<string, unknown> = {}) {
  return {
    name: "localmcp-hub",
    created_on: "2026-11-23T11:12:49.213Z",
    deployed_on: "2026-11-23T11:12:49.213Z",
    subdomain: { enabled: false },
    references: {
      workers: [],
      domains: [],
      dispatch_namespace_outbounds: [],
      durable_objects: [{ name: "RegistryDO" }, { name: "RunnerDO" }],
      queues: []
    },
    ...overrides
  };
}

describe("Cloudflare Worker adoption guard", () => {
  it("allows only the isolated partial upload with its two expected Durable Object references", () => {
    expect(isIsolatedPartialHubWorker(partialWorker(), undefined, now)).toBe(true);
  });

  it("rejects a Worker with any unrelated resource references", () => {
    const worker = partialWorker({
      references: {
        workers: [{ name: "consumer" }],
        durable_objects: [{ name: "RegistryDO" }, { name: "RunnerDO" }]
      }
    });
    expect(isIsolatedPartialHubWorker(worker, undefined, now)).toBe(false);
  });

  it("rejects a Worker with missing or unexpected Durable Object references", () => {
    expect(isIsolatedPartialHubWorker(partialWorker({
      references: { durable_objects: [{ name: "RegistryDO" }] }
    }), undefined, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({
      references: { durable_objects: [{ name: "OtherDO" }, { name: "AnotherDO" }] }
    }), undefined, now)).toBe(true);
  });

  it("rejects active routes, public subdomains, stale metadata, or mismatched timestamps", () => {
    expect(isIsolatedPartialHubWorker(partialWorker(), { pattern: "hub.example.com/*" }, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({ subdomain: { enabled: true } }), undefined, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker(), undefined, now + 31 * 60 * 1000)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({ deployed_on: "2026-11-23T11:13:00.000Z" }), undefined, now)).toBe(false);
  });
});

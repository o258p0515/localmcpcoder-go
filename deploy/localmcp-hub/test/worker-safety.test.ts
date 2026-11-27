import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isIsolatedPartialHubWorker, renderDeployWranglerConfig } from "../scripts/worker-safety.mjs";

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
  it("allows the isolated partial upload with its two Durable Object references", () => {
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

  it("rejects missing or extra Durable Object references", () => {
    expect(isIsolatedPartialHubWorker(partialWorker({
      references: { durable_objects: [{ name: "RegistryDO" }] }
    }), undefined, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({
      references: { durable_objects: [{ name: "RegistryDO" }, { name: "RunnerDO" }, { name: "OtherDO" }] }
    }), undefined, now)).toBe(false);
  });

  it("rejects active routes, public subdomains, stale metadata, or mismatched timestamps", () => {
    expect(isIsolatedPartialHubWorker(partialWorker(), { pattern: "hub.example.com/*" }, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({ subdomain: { enabled: true } }), undefined, now)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker(), undefined, now + 31 * 60 * 1000)).toBe(false);
    expect(isIsolatedPartialHubWorker(partialWorker({ deployed_on: "2026-11-23T11:13:00.000Z" }), undefined, now)).toBe(false);
  });
});

describe("Zero-config MCP_PROXY Service Binding rendering", () => {
  const template = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("auto-attaches MCP_PROXY service binding when github-mcp-proxy Worker exists", () => {
    const rendered = renderDeployWranglerConfig(template, {
      accountId: "acc-123",
      hubDomain: "hub.example.org",
      zoneName: "example.org",
      workerRecords: [{ name: "localmcp-hub" }, { name: "github-mcp-proxy" }]
    });
    expect(rendered.proxyServiceBound).toBe(true);
    expect(rendered.proxyWorkerName).toBe("github-mcp-proxy");
    const parsed = JSON.parse(rendered.configText);
    expect(parsed.account_id).toBe("acc-123");
    expect(parsed.routes).toEqual([{ pattern: "hub.example.org/*", zone_name: "example.org" }]);
    expect(parsed.services).toEqual([{ binding: "MCP_PROXY", service: "github-mcp-proxy" }]);
  });

  it("omits services binding cleanly when github-mcp-proxy is not present in the account", () => {
    const rendered = renderDeployWranglerConfig(template, {
      accountId: "acc-123",
      hubDomain: "hub.example.org",
      zoneName: "example.org",
      workerRecords: [{ name: "localmcp-hub" }]
    });
    expect(rendered.proxyServiceBound).toBe(false);
    expect(rendered.proxyWorkerName).toBeNull();
    const parsed = JSON.parse(rendered.configText);
    expect(parsed.services).toBeUndefined();
  });
});

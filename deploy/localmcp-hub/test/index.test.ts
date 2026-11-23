import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function env(): Env {
  return {
    MCP_TOKEN: "shared-mcp-token-0123456789abcdef",
    ADMIN_TOKEN: "separate-admin-token",
    REGISTRY_DO: { idFromName: () => "global", get: () => ({ fetch: async () => Response.json({ result: [] }) }) } as any,
    RUNNER_DO: { idFromName: () => "runner", get: () => ({ fetch: async () => new Response("upgrade", { status: 426 }) }) } as any
  };
}

describe("Hub authentication uses the existing MCP token", () => {
  it("accepts MCP_TOKEN for outbound runner WebSocket authentication", async () => {
    const response = await worker.fetch(new Request("https://hub.example.com/internal/runner-ws?id=runner-01", {
      headers: { Authorization: "Bearer shared-mcp-token-0123456789abcdef" }
    }), env());
    expect(response.status).toBe(426);
  });

  it("rejects a separate legacy Hub secret", async () => {
    const response = await worker.fetch(new Request("https://hub.example.com/internal/runner-ws?id=runner-01", {
      headers: { Authorization: "Bearer old-hub-secret" }
    }), env());
    expect(response.status).toBe(401);
  });

  it("keeps ADMIN_TOKEN separate from MCP_TOKEN", async () => {
    const denied = await worker.fetch(new Request("https://hub.example.com/admin/runners", {
      headers: { Authorization: "Bearer shared-mcp-token-0123456789abcdef" }
    }), env());
    expect(denied.status).toBe(401);
    const allowed = await worker.fetch(new Request("https://hub.example.com/admin/runners", {
      headers: { Authorization: "Bearer separate-admin-token" }
    }), env());
    expect(allowed.status).toBe(200);
  });
});

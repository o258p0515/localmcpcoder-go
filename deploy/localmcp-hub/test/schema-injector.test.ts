import { describe, expect, it } from "vitest";
import { injectRunnerArguments, stripRunnerArguments } from "../src/schema-injector";

describe("schema injector", () => {
  it("adds runner routing and async flags without mutating the source schema", () => {
    const source = [{ name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
    const result = injectRunnerArguments(source);
    expect(result[0].inputSchema.properties.runner_id.type).toBe("string");
    expect(result[0].inputSchema.properties.async.type).toBe("boolean");
    expect(source[0].inputSchema.properties).not.toHaveProperty("runner_id");
  });
  it("strips hub-only fields before forwarding", () => {
    expect(stripRunnerArguments({ command: "pwd", runner_id: "r1", async: true })).toEqual({
      args: { command: "pwd" }, runnerId: "r1", async: true
    });
  });
});

import { describe, expect, it } from "vitest";
import type { RunnerInfo } from "./types";
import { pairKey, pairedRunner } from "./runner-pairing";

function runner(runner_id: string, tags: string[]): RunnerInfo {
  return { runner_id, os: "linux", arch: "x64", repo: "", tags, status: "online", connected_at: 1 };
}

describe("Hub Agent/Git runner pairing", () => {
  it("matches the Git runner with the same pair key, not the first online Git runner", () => {
    const agent = runner("agent-02", ["agent", "pair:02"]);
    const git01 = runner("git-01", ["git", "isolated", "pair:01"]);
    const git02 = runner("git-02", ["git", "isolated", "pair:02"]);
    expect(pairKey(agent)).toBe("02");
    expect(pairedRunner(agent, [git01, git02])?.runner_id).toBe("git-02");
  });

  it("returns no pair when the source has no pair tag or no matching runner", () => {
    const agent = runner("agent-01", ["agent"]);
    const git = runner("git-02", ["git", "isolated", "pair:02"]);
    expect(pairedRunner(agent, [git])).toBeUndefined();
    expect(pairedRunner(runner("agent-01", ["agent", "pair:01"]), [git])).toBeUndefined();
  });

  it("fails closed when a pair key maps to more than one candidate", () => {
    const agent = runner("agent-01", ["agent", "pair:01"]);
    const first = runner("git-01", ["git", "isolated", "pair:01"]);
    const duplicate = runner("git-01-copy", ["git", "isolated", "pair:01"]);
    expect(pairedRunner(agent, [first, duplicate])).toBeUndefined();
  });
});

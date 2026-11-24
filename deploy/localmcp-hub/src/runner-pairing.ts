import type { RunnerInfo } from "./types";

export function pairKey(runner: RunnerInfo | undefined): string | undefined {
  return runner?.tags?.find((tag) => tag.startsWith("pair:") && tag.length > 5)?.slice(5);
}

export function pairedRunner(source: RunnerInfo | undefined, candidates: RunnerInfo[]): RunnerInfo | undefined {
  const key = pairKey(source);
  if (!key) return undefined;
  const matches = candidates.filter((candidate) => pairKey(candidate) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

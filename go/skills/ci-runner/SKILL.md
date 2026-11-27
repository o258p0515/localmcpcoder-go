---
name: ci-runner
description: Work reliably on ephemeral GitHub Actions runners, zero-downtime handover, idle-skip, and persist outputs.
---
# CI runner
- Treat GitHub Actions runners as ephemeral; local files disappear when the job ends or after handover cutover.
- Persist useful results by committing/pushing them to a branch or uploading workflow artifacts.
- GitHub-hosted jobs have a maximum duration of 6 hours; long-running jobs are interrupted when their timeout is reached.
- GitHub masks configured secrets in logs, but do not deliberately print them.
- Avoid overlapping jobs that mutate the same branch or external resources without coordination.
- Review GitHub Actions terms and policies before using runners for long-lived interactive workloads.

## Zero-Downtime Make-Before-Break Handover & Idle-Skip
- **Automatic rotation:** Ephemeral Hub runners automatically request handover before their lease expires (default `duration_seconds - 600` seconds). The Hub calls the internal `MCP_PROXY` Service Binding to spawn a Gen 2 successor preserving `pair:<id>` and role tags.
- **Persist workspace before cutover:** Gen 2 starts on a brand-new VM with a clean disk. Check `list_runners` (`expires_at`, `handover_state`) and commit/push changes before cutover.
- **Do not spawn duplicates:** If `list_runners` shows `handover_state: "spawning"`, a successor is already booting—do not call `localmcp_hub_start` manually.
- **Seamless session cutover:** Once Gen 2 connects with `--predecessor-id`, the Hub atomically migrates pinned sessions to Gen 2 (no need to re-call `select_runner`) and signals Gen 1 to drain in-flight requests and exit cleanly with code `0`.
- **Always-On vs Idle-Skip:** With default `idle_timeout: 0` and handover enabled, runners continuously hand over across generations even when idle. Pass `idle_timeout > 0` on `localmcp_hub_start` to opt into idle-skip/auto-exit when inactive, or `handover_after: -1` to disable handover for one-off jobs.
- **Persistent sandboxes:** `instabox` and `upstashbox` runners preserve disk and use pause/resume (`reuse_cached: true`) instead of Make-Before-Break handover.

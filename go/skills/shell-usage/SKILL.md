---
name: shell-usage
description: Guidance for running bash, PowerShell, or cmd commands safely with timeouts.
---
# Shell usage
- `bash` runs `bash -lc` on Unix; on Windows select PowerShell or cmd in server config.
- PowerShell uses `-NoProfile -NonInteractive`; cmd uses `/d /s /c`.
- Quote paths containing spaces. Prefer explicit relative paths from the configured root.
- Set `timeout_ms` for commands that may take time; the supported range is 1s–10m.
- Do not run interactive editors, prompts, pagers, or commands waiting for terminal input.
- Read `[exit code: N]`; zero indicates success. Inspect stderr when a command fails.
- Do not attempt to inspect environment variables or print secrets.

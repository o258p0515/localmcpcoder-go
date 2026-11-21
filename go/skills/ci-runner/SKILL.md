---
name: ci-runner
description: Work reliably on ephemeral GitHub Actions runners and persist outputs.
---
# CI runner
- Treat GitHub Actions runners as ephemeral; local files disappear when the job ends.
- Persist useful results by committing/pushing them or uploading workflow artifacts.
- GitHub-hosted jobs have a maximum duration of 6 hours; long-running jobs are interrupted when their timeout is reached.
- GitHub masks configured secrets in logs, but do not deliberately print them.
- Avoid overlapping jobs that mutate the same branch or external resources without coordination.
- Review GitHub Actions terms and policies before using runners for long-lived interactive workloads.

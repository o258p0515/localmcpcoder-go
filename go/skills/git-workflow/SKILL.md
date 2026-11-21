---
name: git-workflow
description: Safe Git branching, reviewing, committing, and pushing workflow.
---
# Git workflow
- Inspect `git status`, branch, and diff before editing or committing.
- Keep commits small and focused; use descriptive imperative commit messages.
- Run tests before committing and inspect staged changes.
- Never commit `.env`, credentials, tokens, private keys, or generated secrets.
- Never force-push unless the user explicitly asks for it.
- Fetch before updating a shared branch and avoid overwriting another contributor's work.

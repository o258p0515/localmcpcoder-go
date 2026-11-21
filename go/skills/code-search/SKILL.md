---
name: code-search
description: Choose glob, grep, or shell ripgrep to find files and code patterns.
---
# Code search
- Use `glob` to find paths by filename or pattern; use `grep` to search file contents.
- Use shell `rg` for advanced searches, context lines, and large repositories when installed.
- `grep` patterns use Go's RE2 regular expressions: lookahead, lookbehind, and backreferences are unsupported.
- Search skips common generated/dependency directories such as `.git`, `node_modules`, `dist`, `build`, `.venv`, and `target`.
- Binary files and files larger than 2 MB are skipped by content search.
- Narrow the search directory and filename filter to reduce noise.

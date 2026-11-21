---
name: getting-started
description: Start here for tool selection, safe file edits, and multi-step coding tasks.
---
# Getting started
- Use paths relative to the configured project root whenever possible.
- Use `list_dir` to inspect a directory, `glob` to find paths by filename, and `grep` to search file contents.
- Always call `read_file` before `edit_file`; preserve surrounding formatting.
- Prefer `edit_file` for focused changes and `write_file` only for whole-file creation or replacement.
- Use `todo_write` and `todo_read` to track multi-step work.
- Run relevant tests and inspect their exit codes after edits.
- Use `bash` for commands; use `read_file`, `write_file`, and `edit_file` for source changes.
- Use `system_info` if OS, shell, or root configuration affects the task.
- Use `skills_list` and `skill_read` to discover and read relevant procedures; `skills_reload` refreshes user skills.

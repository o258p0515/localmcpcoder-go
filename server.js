import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { installOAuth } from "./oauth.js";

// ---------------------------------------------------------------------------
// Configuration (environment variables — see README)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.MCP_PORT || 8787);
const TOKEN = process.env.MCP_TOKEN || "";
const ROOT = path.resolve(process.env.MCP_ROOT || process.cwd());
const ALLOW_OUTSIDE_ROOT = process.env.MCP_ALLOW_OUTSIDE_ROOT === "1";
const SHELL = process.env.MCP_SHELL || (process.platform === "win32" ? "powershell" : "bash");
const MAX_OUTPUT = Number(process.env.MCP_MAX_OUTPUT || 60_000);

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    "ERROR: MCP_TOKEN is missing (16 characters minimum).\n" +
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n' +
      "or just run ./start.sh (macOS/Linux) or .\\start.ps1 (Windows), which do it for you."
  );
  process.exit(1);
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build",
  ".next", ".cache", ".idea", ".gradle", "target",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// The root itself may sit behind a symlink (/tmp -> /private/tmp on macOS), so
// the boundary has to be compared in resolved form too.
const REAL_ROOT = (() => {
  try {
    return realpathSync(ROOT);
  } catch {
    return ROOT;
  }
})();

/**
 * Resolves symlinks in `abs`. write_file legitimately targets files that do not
 * exist yet, and realpath fails on those, so this walks up to the nearest
 * ancestor that does exist and re-appends the missing tail.
 */
function realPathAllowingMissing(abs) {
  const missing = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...missing);
    } catch (e) {
      if (e.code !== "ENOENT") return abs; // permissions, ELOOP, … let fs report it
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root
      missing.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function resolvePath(p) {
  const abs = path.resolve(ROOT, p ?? ".");
  if (ALLOW_OUTSIDE_ROOT) return abs;

  // path.relative is pure string arithmetic and never touches the disk, so on
  // its own it would accept a symlink that lives inside the root but points
  // outside it — and fs would then happily follow the link. Resolve first.
  const real = realPathAllowingMissing(abs);
  const rel = path.relative(REAL_ROOT, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path is outside the allowed directory (${ROOT}): ${abs}. ` +
        `Set MCP_ALLOW_OUTSIDE_ROOT=1 to allow the whole disk.`
    );
  }
  return real;
}

function clamp(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return (
    text.slice(0, MAX_OUTPUT) +
    `\n\n... [output truncated, ${text.length - MAX_OUTPUT} characters omitted]`
  );
}

const ok = (text) => ({ content: [{ type: "text", text: clamp(String(text)) }] });
const fail = (err) => ({
  content: [{ type: "text", text: clamp(`Error: ${err?.message ?? err}`) }],
  isError: true,
});

/** Wraps a handler so failures come back as isError instead of an HTTP 500. */
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

async function* walk(dir, depth = 0) {
  if (depth > 25) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer(
    { name: "localmcpcoder", version: "1.0.0" },
    {
      instructions:
        `MCP server with access to the user's desktop machine. ` +
        `Working directory: ${ROOT}. Use paths relative to that directory. ` +
        `Always read a file with read_file before editing it.`,
    }
  );

  // --- shell --------------------------------------------------------------
  server.registerTool(
    "bash",
    {
      title: "Run a shell command",
      description:
        `Runs a command in the machine's shell (${SHELL}) and returns stdout, stderr and the exit code. ` +
        `The default working directory is ${ROOT}. Interactive commands are not supported.`,
      inputSchema: {
        command: z.string().describe("Command to run"),
        cwd: z.string().optional().describe("Working directory, relative to the root"),
        timeout_ms: z.number().int().min(1000).max(600_000).optional()
          .describe("Timeout in milliseconds (default 120000)"),
      },
    },
    guard(async ({ command, cwd, timeout_ms }) => {
      const workdir = resolvePath(cwd ?? ".");
      const timeout = timeout_ms ?? 120_000;

      const [file, args] =
        SHELL === "cmd"
          ? ["cmd.exe", ["/d", "/s", "/c", command]]
          : SHELL === "bash"
          ? ["bash", ["-lc", command]]
          : [
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            ];

      return await new Promise((resolve) => {
        const child = spawn(file, args, {
          cwd: workdir,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);

        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve(fail(e));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const parts = [];
          if (out.trim()) parts.push(out.trimEnd());
          if (err.trim()) parts.push(`[stderr]\n${err.trimEnd()}`);
          if (killed) parts.push(`[timed out after ${timeout}ms — process killed]`);
          parts.push(`[exit code: ${code}]`);
          resolve(ok(parts.join("\n\n")));
        });
      });
    })
  );

  // --- read ---------------------------------------------------------------
  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description:
        "Reads a text file and returns it with line numbers. Use offset/limit for large files.",
      inputSchema: {
        file_path: z.string().describe("File path, relative to the root or absolute"),
        offset: z.number().int().min(1).optional().describe("First line to read (1-indexed)"),
        limit: z.number().int().min(1).max(5000).optional().describe("Number of lines (default 2000)"),
      },
    },
    guard(async ({ file_path, offset, limit }) => {
      const abs = resolvePath(file_path);
      const raw = await fs.readFile(abs, "utf8");
      const lines = raw.split(/\r?\n/);
      const start = (offset ?? 1) - 1;
      const end = Math.min(lines.length, start + (limit ?? 2000));
      const body = lines
        .slice(start, end)
        .map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`)
        .join("\n");
      const footer =
        end < lines.length ? `\n\n... [${lines.length - end} more lines, use offset=${end + 1}]` : "";
      return ok(body + footer);
    })
  );

  // --- write --------------------------------------------------------------
  server.registerTool(
    "write_file",
    {
      title: "Write a file",
      description:
        "Creates or overwrites a whole file. Prefer edit_file for partial changes. Missing directories are created.",
      inputSchema: {
        file_path: z.string().describe("File path"),
        content: z.string().describe("Full file content"),
      },
    },
    guard(async ({ file_path, content }) => {
      const abs = resolvePath(file_path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const existed = await fs
        .access(abs)
        .then(() => true)
        .catch(() => false);
      await fs.writeFile(abs, content, "utf8");
      return ok(
        `${existed ? "Overwrote" : "Created"}: ${abs} (${content.split(/\r?\n/).length} lines)`
      );
    })
  );

  // --- edit ---------------------------------------------------------------
  server.registerTool(
    "edit_file",
    {
      title: "Edit a file",
      description:
        "Exact string replacement inside a file. old_string must appear exactly once " +
        "(or pass replace_all). Read the file first so you copy the exact text, including indentation.",
      inputSchema: {
        file_path: z.string().describe("File path"),
        old_string: z.string().describe("Exact text to replace"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace every occurrence"),
      },
    },
    guard(async ({ file_path, old_string, new_string, replace_all }) => {
      const abs = resolvePath(file_path);
      const raw = await fs.readFile(abs, "utf8");
      const count = raw.split(old_string).length - 1;
      if (count === 0) throw new Error("old_string was not found in the file.");
      if (count > 1 && !replace_all)
        throw new Error(
          `old_string appears ${count} times. Add more context or pass replace_all: true.`
        );
      const updated = replace_all
        ? raw.split(old_string).join(new_string)
        : raw.replace(old_string, new_string);
      await fs.writeFile(abs, updated, "utf8");
      return ok(`Edited ${abs} (${replace_all ? count : 1} replacement(s))`);
    })
  );

  // --- list ---------------------------------------------------------------
  server.registerTool(
    "list_dir",
    {
      title: "List a directory",
      description: "Lists the files and folders in a directory.",
      inputSchema: {
        dir_path: z.string().optional().describe("Directory (defaults to the root)"),
      },
    },
    guard(async ({ dir_path }) => {
      const abs = resolvePath(dir_path ?? ".");
      const entries = await fs.readdir(abs, { withFileTypes: true });
      if (!entries.length) return ok(`${abs} (empty)`);
      const rows = await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) return `  dir   ${e.name}/`;
          const st = await fs.stat(path.join(abs, e.name)).catch(() => null);
          return `  file  ${e.name}${st ? `  (${st.size} bytes)` : ""}`;
        })
      );
      return ok(`${abs}\n${rows.sort().join("\n")}`);
    })
  );

  // --- glob ---------------------------------------------------------------
  server.registerTool(
    "glob",
    {
      title: "Find files by name",
      description:
        "Finds files matching a glob pattern (e.g. **/*.js, src/**/*.py). Returns paths sorted by modification time.",
      inputSchema: {
        pattern: z.string().describe("Glob pattern"),
        dir_path: z.string().optional().describe("Base directory (defaults to the root)"),
      },
    },
    guard(async ({ pattern, dir_path }) => {
      const base = resolvePath(dir_path ?? ".");
      const found = [];
      for await (const m of fs.glob(pattern, { cwd: base })) {
        const abs = path.resolve(base, m);
        if (IGNORED_DIRS.has(path.relative(base, abs).split(path.sep)[0])) continue;
        const st = await fs.stat(abs).catch(() => null);
        if (st?.isFile()) found.push({ abs, mtime: st.mtimeMs });
        if (found.length >= 500) break;
      }
      if (!found.length) return ok(`No matches for "${pattern}" in ${base}`);
      found.sort((a, b) => b.mtime - a.mtime);
      return ok(found.map((f) => f.abs).join("\n"));
    })
  );

  // --- grep ---------------------------------------------------------------
  server.registerTool(
    "grep",
    {
      title: "Search file contents",
      description:
        "Searches for a regular expression inside files. Returns file:line plus the matching text.",
      inputSchema: {
        pattern: z.string().describe("Regular expression"),
        dir_path: z.string().optional().describe("Base directory (defaults to the root)"),
        glob: z.string().optional().describe("Filename filter, e.g. *.ts"),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().min(1).max(1000).optional().describe("Default 200"),
      },
    },
    guard(async ({ pattern, dir_path, glob, case_insensitive, max_results }) => {
      const base = resolvePath(dir_path ?? ".");
      const re = new RegExp(pattern, case_insensitive ? "i" : "");
      const nameRe = glob
        ? new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")
        : null;
      const limit = max_results ?? 200;
      const hits = [];

      for await (const file of walk(base)) {
        if (nameRe && !nameRe.test(path.basename(file))) continue;
        const st = await fs.stat(file).catch(() => null);
        if (!st || st.size > 2_000_000) continue;
        let text;
        try {
          text = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue; // binary file
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (hits.length >= limit) break;
          }
        }
        if (hits.length >= limit) break;
      }
      return ok(hits.length ? hits.join("\n") : `No matches for /${pattern}/ in ${base}`);
    })
  );

  // --- todo ---------------------------------------------------------------
  server.registerTool(
    "todo_write",
    {
      title: "Save the task list",
      description:
        "Saves or updates the session task list, to keep track of the plan during longer jobs.",
      inputSchema: {
        todos: z
          .array(
            z.object({
              content: z.string(),
              status: z.enum(["pending", "in_progress", "completed"]),
            })
          )
          .describe("The complete task list (replaces the previous one)"),
      },
    },
    guard(async ({ todos }) => {
      globalThis.__todos = todos;
      const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
      return ok(todos.map((t) => `${icon[t.status]} ${t.content}`).join("\n") || "(empty)");
    })
  );

  server.registerTool(
    "todo_read",
    {
      title: "Read the task list",
      description: "Returns the saved task list.",
      inputSchema: {},
    },
    guard(async () => {
      const todos = globalThis.__todos ?? [];
      const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
      return ok(todos.map((t) => `${icon[t.status]} ${t.content}`).join("\n") || "(no tasks)");
    })
  );

  // --- info ---------------------------------------------------------------
  server.registerTool(
    "system_info",
    {
      title: "Environment info",
      description: "Returns machine details: OS, user, allowed root directory and shell.",
      inputSchema: {},
    },
    guard(async () =>
      ok(
        [
          `OS: ${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
          `Host: ${os.hostname()}`,
          `User: ${os.userInfo().username}`,
          `Node: ${process.version}`,
          `Shell: ${SHELL}`,
          `Allowed root: ${ROOT}`,
          `Access outside root: ${ALLOW_OUTSIDE_ROOT ? "yes" : "no"}`,
        ].join("\n")
      )
    )
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP layer (Streamable HTTP, stateless: one server + transport per request)
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "16mb" }));
app.use(express.urlencoded({ extended: false })); // OAuth uses form encoding

// Everything below the OAuth endpoints requires a bearer token. The endpoints
// themselves are necessarily public — that is how a client discovers how to
// authenticate — but they hand out nothing without the passphrase.
const { requireAuth } = installOAuth(app, { passphrase: TOKEN });

// Reveals nothing about the machine: the old version returned MCP_ROOT, which
// leaked the username to anyone who found the hostname.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Error handling MCP request:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

app.post("/mcp", requireAuth, handleMcp);

// The token used to travel in the path (/mcp/<token>), which put the secret in
// every proxy and edge log it passed through. It now goes in the Authorization
// header only; this stub explains the change instead of 404ing.
app.all("/mcp/:token", (_req, res) =>
  res.status(410).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message:
        "The /mcp/<token> URL was removed. Use https://<host>/mcp and authenticate " +
        "with OAuth, or send 'Authorization: Bearer <passphrase>'.",
    },
    id: null,
  })
);

// GET/DELETE do not apply in stateless mode, but answer cleanly instead of 404.
const notAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  localmcpcoder listening on http://127.0.0.1:" + PORT);
  console.log("  Allowed root  : " + ROOT);
  console.log("  Outside root  : " + (ALLOW_OUTSIDE_ROOT ? "ALLOWED" : "blocked"));
  console.log("  Shell         : " + SHELL);
  console.log("  Local endpoint: http://127.0.0.1:" + PORT + "/mcp  (OAuth, or Bearer <passphrase>)");
  console.log("");
});

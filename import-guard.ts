/**
 * AHE Evolution #3 — Import Guard Middleware
 *
 * Prediction: Detecting missing Python imports at write-time lets the agent
 * create the module before running, saving one "run-to-see-error" round-trip.
 *
 * How it works:
 *   1. After writing/editing a .py file, scan for import statements
 *   2. Check if imported local modules exist on disk
 *   3. If not, notify the agent immediately with a suggestion
 *
 * Metric: debug-import task calls
 * Baseline R2: 4 (write → bash → write → py)
 * Target: 3 (write → write → py)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Import Analyzer ─────────────────────────────────────────────

interface ImportInfo {
  module: string;
  isRelative: boolean;
  expectedPath: string | null;
  exists: boolean;
}

const STDLIB_MODULES = new Set([
  "abc", "argparse", "asyncio", "base64", "collections", "contextlib", "csv",
  "dataclasses", "datetime", "decimal", "enum", "functools", "glob", "hashlib",
  "http", "importlib", "inspect", "io", "itertools", "json", "logging", "math",
  "os", "pathlib", "pickle", "random", "re", "shutil", "sqlite3", "statistics",
  "subprocess", "sys", "tempfile", "threading", "time", "traceback", "typing", "unittest",
  "urllib", "uuid", "xml", "zipfile", "zoneinfo",
]);

function analyzeImports(filePath: string, cwd: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Match: from X import Y, import X
    const fromImportRegex = /^\s*from\s+([\w.]+)\s+import\s+/;
    const directImportRegex = /^\s*import\s+([\w.,\s]+)/;

    for (const line of lines) {
      let match: RegExpMatchArray | null;

      match = line.match(fromImportRegex);
      if (match) {
        const module = match[1];
        const info = checkModule(module, filePath, cwd);
        imports.push(info);
        continue;
      }

      match = line.match(directImportRegex);
      if (match) {
        const modules = match[1]
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
        for (const module of modules) {
          const info = checkModule(module, filePath, cwd);
          imports.push(info);
        }
      }
    }
  } catch {
    // Can't read file
  }

  return imports;
}

function checkModule(
  moduleName: string,
  sourceFile: string,
  cwd: string
): ImportInfo {
  const topLevel = moduleName.replace(/^\.+/, "").split(".")[0];
  if (!moduleName.startsWith(".") && STDLIB_MODULES.has(topLevel)) {
    return { module: moduleName, isRelative: false, expectedPath: null, exists: true };
  }

  const sourceDir = path.dirname(path.resolve(cwd, sourceFile));
  const searchRoots = [sourceDir, path.resolve(cwd)];

  let expectedPath: string | null = null;
  const candidates: string[] = [];

  if (moduleName.startsWith(".")) {
    const parts = moduleName.split(".");
    const leadingDots = parts.findIndex((part) => part !== "");
    const upLevels = Math.max(0, leadingDots - 1);
    const names = parts.slice(leadingDots === -1 ? parts.length : leadingDots);
    const baseDir = Array.from({ length: upLevels }).reduce((dir) => path.dirname(dir as string), sourceDir as string);
    candidates.push(path.join(baseDir, ...names) + ".py");
    candidates.push(path.join(baseDir, ...names, "__init__.py"));
  } else {
    const parts = moduleName.split(".");
    for (const root of searchRoots) {
      candidates.push(path.join(root, ...parts) + ".py");
      candidates.push(path.join(root, ...parts, "__init__.py"));
      if (parts.length > 1) {
        candidates.push(path.join(root, ...parts.slice(0, -1), parts[parts.length - 1] + ".py"));
      }
    }
  }

  expectedPath = candidates[0] || null;
  const foundPath = candidates.find((candidate) => fs.existsSync(candidate));

  return {
    module: moduleName,
    isRelative: moduleName.startsWith(".") || Boolean(foundPath),
    expectedPath: foundPath || expectedPath,
    exists: Boolean(foundPath),
  };
}

// Variant of analyzeImports that works on raw content instead of reading from disk
function analyzeImportsFromContent(
  content: string,
  sourceFilePath: string,
  cwd: string
): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = content.split("\n");
  const fromImportRegex = /^\s*from\s+([\w.]+)\s+import\s+/;
  const directImportRegex = /^\s*import\s+([\w.,\s]+)/;

  for (const line of lines) {
    let match = line.match(fromImportRegex);
    if (match) {
      imports.push(checkModule(match[1], sourceFilePath, cwd));
      continue;
    }
    match = line.match(directImportRegex);
    if (match) {
      const modules = match[1]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      for (const mod of modules) {
        imports.push(checkModule(mod, sourceFilePath, cwd));
      }
    }
  }
  return imports;
}

// ─── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Turn-scoped pending writes for proactive cross-file import checking
  const pendingWrites = new Map<string, string>();

  pi.on("before_agent_start", async (_event, _ctx) => {
    pendingWrites.clear();
  });

  /**
   * Proactive mode: pre-check imports BEFORE write executes.
   * Cross-references against files on disk AND files in the same write batch.
   */
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const input = event.input as any;
    const filePath = input?.path || input?.file_path || input?.file || "";
    if (!filePath.endsWith(".py")) return;

    const content = input?.content || input?.text || "";
    if (!content) return;

    pendingWrites.set(filePath, content);

    const cwd = ctx.cwd;
    const imports = analyzeImportsFromContent(content, filePath, cwd);
    const missing = imports.filter((imp) => {
      if (imp.exists) return false;
      if (imp.expectedPath) {
        const absExpected = path.resolve(cwd, imp.expectedPath);
        for (const [pendingPath] of pendingWrites) {
          if (path.resolve(cwd, pendingPath) === absExpected) return false;
        }
      }
      return true;
    });

    if (missing.length > 0) {
      const missingList = missing
        .map((m) => {
          const rel = m.expectedPath ? path.relative(cwd, m.expectedPath) : m.module;
          return `\`${rel}\``;
        })
        .join(", ");
      ctx.ui.notify?.(
        `Import guard (proactive): ${missing.length} missing — ${missing.map((m) => m.module).join(", ")}`,
        "warning"
      );
      pi.sendUserMessage(
        `[Import Guard] \`${filePath}\` imports: ${missing.map((m) => m.module).join(", ")}. ` +
          `These modules are not on disk and not in this write batch. ` +
          `Also create: ${missingList} before running the code.`,
        { deliverAs: "steer" }
      );
    }
  });

  /**
   * After writing/editing a .py file, check imports.
   */
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    const input = event.input as any;
    const filePath = input?.path || input?.file_path || input?.file || "";
    if (!filePath.endsWith(".py")) return;

    const cwd = ctx.cwd;
    const absPath = path.resolve(cwd, filePath);
    const imports = analyzeImports(absPath, cwd);
    const missing = imports.filter((i) => !i.exists);

    if (missing.length === 0) return;

    const lines: string[] = [
      "━━━ Import Analysis ━━━",
      `File: ${filePath}`,
      `Missing imports: ${missing.length}`,
      "",
    ];

    for (const imp of missing) {
      lines.push(`📦 ${imp.module}`);
      if (imp.expectedPath) {
        lines.push(`   Expected: ${path.relative(cwd, imp.expectedPath)}`);
        lines.push(`   Action: create this file before running`);
      } else {
        lines.push(`   ⚠️ Could not resolve path — check spelling`);

        // Check for common typos
        const commonModules = [
          "os", "sys", "json", "re", "math", "random", "datetime",
          "collections", "itertools", "functools", "pathlib", "typing",
          "subprocess", "tempfile", "shutil", "hashlib", "logging",
        ];
        if (commonModules.includes(imp.module)) {
          lines.push(`   ℹ️ "${imp.module}" is a standard library module — should be available`);
        }
      }
      lines.push("");
    }

    ctx.ui.notify?.(
      `Import guard: ${missing.length} missing module(s) — create before running`,
      "warning"
    );
    ctx.ui.setWidget?.("import-guard", lines);
  });

  // ── Tool: check imports ──
  pi.registerTool({
    name: "check_imports",
    label: "Check Python Imports",
    description:
      "Scan a Python file for import statements and check if all imported modules exist on disk. Returns missing modules with suggested file paths.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Python file to check (relative path)",
        },
      },
      required: ["file"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absPath = path.resolve(ctx.cwd, params.file);

      if (!fs.existsSync(absPath)) {
        return {
          content: [
            { type: "text", text: `File not found: ${params.file}` },
          ],
        };
      }

      const imports = analyzeImports(absPath, ctx.cwd);
      const missing = imports.filter((i) => !i.exists);
      const found = imports.filter((i) => i.exists);

      const lines: string[] = [
        `## Import Analysis: ${params.file}`,
        "",
        `**Total imports:** ${imports.length}`,
        `**Found:** ${found.length}`,
        `**Missing:** ${missing.length}`,
        "",
      ];

      if (found.length > 0) {
        lines.push("### ✅ Found");
        for (const imp of found) {
          lines.push(`- \`${imp.module}\` → ${imp.expectedPath ? path.relative(ctx.cwd, imp.expectedPath) : "built-in/stdlib"}`);
        }
        lines.push("");
      }

      if (missing.length > 0) {
        lines.push("### ❌ Missing");
        for (const imp of missing) {
          lines.push(`- \`${imp.module}\``);
          if (imp.expectedPath) {
            const relPath = path.relative(ctx.cwd, imp.expectedPath);
            lines.push(`  → Create: \`${relPath}\``);
          }
        }
        lines.push("");
        lines.push("**Suggestion:** Create the missing modules before running this file.");
      } else {
        lines.push("✅ All imports resolved.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { total: imports.length, missing: missing.length },
      };
    },
  });

  pi.registerCommand("ahe:imports", {
    description: "Show import guard status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Import guard middleware active", "info");
      ctx.ui.notify(
        "Automatically detects missing Python imports after file writes.",
        "info"
      );
    },
  });
}

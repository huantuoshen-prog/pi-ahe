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

function analyzeImports(filePath: string, cwd: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Match: from X import Y, import X
    const fromImportRegex = /^\s*from\s+([\w.]+)\s+import\s+/;
    const directImportRegex = /^\s*import\s+([\w.]+)/;

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
        const module = match[1];
        const info = checkModule(module, filePath, cwd);
        imports.push(info);
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
  // Is it a relative/local import? (starts with . or is a simple name like "utils")
  const isRelative =
    moduleName.startsWith(".") ||
    !moduleName.includes(".") ||
    // Common patterns: mypackage.module
    false;

  // Try to resolve the expected path
  const sourceDir = path.dirname(path.resolve(cwd, sourceFile));
  let expectedPath: string | null = null;

  if (moduleName.startsWith(".")) {
    // Relative import: from .utils import X
    // Convert to path
    const parts = moduleName.split(".");
    const relPath = parts.slice(1).join("/"); // skip the leading empty from split
    expectedPath = path.join(sourceDir, relPath);
  } else if (!moduleName.includes(".")) {
    // Simple import: import utils → utils/__init__.py or utils.py
    const asPackage = path.join(sourceDir, moduleName, "__init__.py");
    const asModule = path.join(sourceDir, moduleName + ".py");

    if (fs.existsSync(asPackage)) {
      expectedPath = asPackage;
    } else if (fs.existsSync(asModule)) {
      expectedPath = asModule;
    } else {
      // Neither exists — report the more likely form
      expectedPath = asPackage;
    }
  } else {
    // Dotted import: import mypackage.utils
    const parts = moduleName.split(".");
    expectedPath = path.join(sourceDir, ...parts.slice(0, -1), parts[parts.length - 1] + ".py");
  }

  const exists = expectedPath ? fs.existsSync(expectedPath) : true; // unknown = assume exists

  return {
    module: moduleName,
    isRelative,
    expectedPath,
    exists,
  };
}

// ─── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /**
   * After writing/editing a .py file, check imports.
   */
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    const input = event.input as any;
    const filePath = input?.path || "";
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
